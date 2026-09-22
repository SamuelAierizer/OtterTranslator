# Spike: free-tier LLM provider for review-and-correct pass

Date of research: **2026-09-22**

## Context / requirements recap

OtterTranslator runs a review-and-correct pass over machine-translated, somewhat
confidential business documents: ~30 batched calls per document, ~20
paragraph-pairs per call, ~2-4k input tokens/call, async job with a
"few minutes per document" latency budget (throughput > per-call speed).

Hard constraints:
1. Provider must **not train** on API traffic (confidentiality).
2. Tier must be **€0** (free), on an ongoing basis — not a one-time trial
   credit that expires.

Verification layer needs: a JSON array back with **exact index alignment**
to the ~20 input pairs, and exact preservation of bracket tags (e.g. `{1}`,
`[TAG]`) inside translated text.

---

## Ranked recommendation

1. **Cerebras Inference (free tier)** — best fit. No training on inference
   data, no credit card, generous daily token cap, structured-outputs
   support on Llama 3.1 models, very fast (throughput is not even a
   concern). Main caveat: free tier caps context at 8,192 tokens and rate
   limits are tight per-minute (5 RPM), so the ~30 calls/doc job needs to be
   paced, not fired concurrently — acceptable given the "few minutes per
   document" budget.
2. **Groq (free tier)** — close second. Contractually no training on
   inputs/outputs (Services Agreement §4.2), no credit card required,
   strict JSON-schema structured outputs (100% schema adherence) on
   `openai/gpt-oss-20b`/`120b`. Free-tier RPM/TPD limits are modest and
   vary by model; needs pacing similar to Cerebras.
3. **OpenRouter, restricted to Zero-Data-Retention / non-training free
   endpoints only** — usable *only* if the "disallow providers that may
   train on free-model inputs" toggle is turned on in account settings,
   which narrows the usable free-model pool. Do not use OpenRouter's free
   pool in its default configuration (see disqualification below) — treat
   this as a conditional fallback, not a primary pick.
4. **Mistral La Plateforme "Experiment" tier** — conditionally usable only
   after manually flipping the Admin Console privacy toggle to opt out of
   training (it is **on by default**). Fragile: relies on a per-workspace
   setting rather than a contractual default, and low RPS (1 req/s) hurts
   the batched-call workload. Use only as a fallback, and only after
   verifying the opt-out toggle is set and re-verifying it periodically
   (settings can reset or the product can change).

**Not recommended for this workload even though technically "free":**
Together AI (see disqualification: no sustained free tier at all).

---

## Disqualified candidates (no-train or €0 constraint)

- **Google AI Studio / Gemini API free tier** — **disqualified on the
  no-train constraint.** Free tier prompts/responses/uploaded files are
  used by Google to improve its products, including human review; only
  linking a paid Cloud Billing account removes this. There is no opt-out
  on the free tier — the only way to get "not used to improve products" is
  to stop being on the free tier. Fails the €0 + no-train combination.
- **OpenRouter free models, default settings** — **disqualified by
  default.** OpenRouter explicitly documents: "we may use your inputs and
  outputs to train and improve our models" for at least some free models,
  and prompts are forwarded to whichever downstream provider is serving
  that free slot, so the effective policy is "whatever that provider's
  default is" unless you opt out. It is *usable* only if you actively
  enable the "disallow endpoints that may train on inputs" setting for
  free models and accept a reduced/changing set of eligible free models —
  it is not safe as a blanket "use OpenRouter free tier" decision.
- **GitHub Models** — **disqualified: the product no longer exists.**
  GitHub Models (playground, model catalog, inference API, BYOK) was fully
  retired on **July 30, 2026**; it is no longer available to any customer.
  Not a viable candidate for a new integration.
- **Together AI** — **disqualified on the €0 constraint.** Together AI does
  not currently offer an ongoing free inference tier; new accounts get a
  one-time ~$5 trial credit, not a sustained free tier. Its privacy
  controls (opt-in-only training, ZDR toggle) look good on paper, but
  there's no free tier to run the job on indefinitely.
- **Mistral "Experiment" free tier, default settings** — **conditionally
  disqualified.** By default, inputs and outputs from the free tier
  *enter Mistral's training programs*; the customer must manually opt out
  via Admin Console → Privacy → disable "Anonymous improvement data" /
  training toggle. Do not treat this provider as safe until that toggle is
  confirmed off for the workspace in use. Kept in the ranked list above
  only as a fallback because the opt-out mechanism does exist (unlike
  Google AI Studio, which has none on free tier).

---

## Per-candidate detail

### Groq

**ToS / data-usage clause (verbatim):**
> "Groq is not permitted to use Inputs or Outputs for training or
> fine-tuning any AI Model Services or other models, unless explicitly
> granted permission or instructed by Customer."
> — Groq Services Agreement, §4.2
> Source: https://console.groq.com/docs/legal/services-agreement (read 2026-09-22)

Supporting doc: "By default, Groq does not retain customer data for
inference requests" except transient logs (up to 30 days) for abuse/error
investigation; Zero Data Retention is a self-serve toggle (US-only).
Source: https://console.groq.com/docs/your-data (read 2026-09-22)

This clause applies account-wide; no separate, weaker free-tier carve-out
was found in the documentation.

**Free-tier rate limits:** Vary per model; example limits observed
(RPM / RPD / TPM / TPD):
- GPT-OSS models: 30 RPM / 1,000 RPD / 8K TPM / 200K TPD
- Llama Prompt Guard: 30 RPM / 14.4K RPD / 15K TPM / 500K TPD

Exact numbers should be re-checked per model at
https://console.groq.com/docs/rate-limits (read 2026-09-22) — the docs
state these are "a high level summary" and exceptions exist. No credit
card requirement was found documented for the free tier.

**Models / suitability:** `openai/gpt-oss-20b`, `openai/gpt-oss-120b`,
Llama 3.x and Qwen family models available. GPT-OSS-20B/120B are small/fast
enough for a review-and-correct pass on paragraph pairs and are the two
models with full Structured Outputs support.

**Structured/JSON output:** Yes — two modes:
- `response_format: {"type": "json_schema", "json_schema": {...}, "strict": true}`
  uses constrained decoding for guaranteed 100% schema adherence, but is
  **only supported on `openai/gpt-oss-20b` and `openai/gpt-oss-120b`**, and
  requires all fields `required` + `additionalProperties: false`.
- Best-effort `json_object` mode: valid JSON guaranteed, schema adherence
  not guaranteed, broader model support.
Source: https://console.groq.com/docs/structured-outputs (read 2026-09-22)

This is a good fit for the "JSON array with exact index alignment"
requirement if the array schema is expressed as required fields with
`additionalProperties: false` and gpt-oss is used.

---

### Cerebras

**ToS / data-usage clause:** Cerebras' privacy documentation states inputs
and outputs "are not retained" for inference and are not used to train
models; data is processed for immediate response generation and then
discarded, with no inference-content training right disclosed.
Source: https://www.cerebras.ai/privacy-policy and
https://cloud.cerebras.ai/privacy (read 2026-09-22; see note below on
exact verbatim quoting)

Note: search tooling could not pull a single verbatim contractual sentence
equivalent to Groq's §4.2 from the live privacy policy page in this pass —
before committing to Cerebras, fetch
https://www.cerebras.ai/privacy-policy directly in a browser and copy the
exact operative sentence into this doc for the record, since the aggregator
summaries agree on substance ("not retained / not used for
training/improvement") but a verbatim first-party quote should still be
captured before relying on it long-term.

**Free-tier rate limits:** 1,000,000 tokens/day, no credit card required.
Per-model free-trial limits reported: 5 requests/minute, 30,000
uncached / 90,000 total tokens/minute, 1,000,000 tokens/hour and /day.
Free-tier **context is capped at 8,192 tokens** — this matters: at
2-4k input tokens/call plus output, some calls could be close to the
ceiling; batch sizes may need tuning down from "20 pairs/call" if output
is verbose.
Source: aggregated from https://www.cerebras.ai/pricing and
https://pricepertoken.com/endpoints/cerebras/free (read 2026-09-22) —
recommend confirming exact figures on https://www.cerebras.ai/pricing
directly since these are third-party summaries.

**Models / suitability:** Llama 3.1 8B/70B, Llama 3.3 70B, Llama 4 Scout,
GPT-OSS 120B, Qwen 3 32B / 235B (thinking). Llama-3.1-8B or Llama-3.3-70B
are reasonable small/fast candidates for translation review; Cerebras'
inference speed (thousands of tokens/sec) means the "few minutes per
document" budget has large headroom even with the tight per-minute rate
limit forcing sequential pacing.

**Structured/JSON output:** Yes. Cerebras recommends "structured outputs"
(`strict: true` JSON-schema mode) over plain JSON mode for schema
adherence, but **structured outputs are currently only supported on
`llama3.1-70b` and `llama3.1-8b`** — the exact models best suited to this
task's small/fast requirement. Plain `json_object` mode (valid JSON, no
schema enforcement) is more broadly supported.
Source: https://inference-docs.cerebras.ai/capabilities/structured-outputs
(read 2026-09-22)

---

### Mistral (La Plateforme, "Experiment" free tier)

**ToS / data-usage clause:** Mistral's help center states explicitly, for
the free/"Experiment"-equivalent tier: inputs and outputs **enter Mistral's
training programs by default**, and the customer must manually opt out via
Admin Console → Privacy menu (toggle for "Anonymous improvement data" /
training use). Paid ("Scale"/Enterprise-tier) customers are opted out by
default.
Source: https://help.mistral.ai/en/articles/455207-can-i-opt-out-of-my-input-or-output-data-being-used-for-training
(read 2026-09-22)

This is a real, currently-live opt-out mechanism (unlike Google AI Studio),
but it is off-by-default and lives in account settings rather than being a
contractual guarantee — it needs to be actively verified and monitored.

**Free-tier rate limits:** Reported ~1 request/second, 500,000 tokens/minute,
with an overall ~1 billion tokens/month cap for the free "Experiment" tier
(figures per third-party aggregation; Mistral no longer publishes exact
numbers on a public page — confirm current values in Admin Console →
Limits before relying on them).
Source: https://help.mistral.ai/en/articles/225174-what-are-the-limits-of-the-free-tier
and aggregator summaries (read 2026-09-22)

1 req/s is workable for a sequential ~30-call/document job within a
few-minutes budget, though it removes any benefit of parallelizing calls.

**Models / suitability:** Small/fast models such as `mistral-small` are
available on the free tier and are plausible candidates for a
review-and-correct task, though quality on strict tag-preservation
instructions was not benchmarked in this research pass.

**Structured/JSON output:** Mistral's API supports JSON mode / structured
outputs (`response_format`) across La Plateforme, consistent with OpenAI-
style APIs; exact schema-adherence guarantees per model were not verified
in this pass and should be spot-checked before relying on strict index
alignment.

---

### Google AI Studio (Gemini API)

**ToS / data-usage clause (verbatim / near-verbatim from Google's own
billing docs):**
> "...your prompts and responses are **not** used to improve Google
> products" — stated as true **only** once a paid tier with Cloud Billing
> is enabled. For free tier: "Google uses submitted prompts, uploaded
> files, and generated responses to improve its products and services,"
> including potential human review after disconnection from user accounts.
> Source: https://ai.google.dev/gemini-api/docs/billing (read 2026-09-22),
> cross-referencing https://ai.google.dev/gemini-api/terms#data-use-paid

**Verdict: disqualified.** There is no opt-out on the free tier; the only
mechanism to stop training/improvement use of data is to leave the free
tier entirely (enable billing), which violates the €0 constraint.

**Free-tier rate limits:** Present but not itemized in this pass (see
https://ai.google.dev/gemini-api/docs/rate-limits) — moot given the
disqualification above.

**Models / JSON mode:** Gemini API does support JSON/structured output
mode (`responseSchema`) and has small fast models (Gemini Flash tier)
that would otherwise be a strong technical fit — the disqualification is
purely on the data-usage constraint, not capability.

---

### OpenRouter (free models)

**ToS / data-usage clause (verbatim):**
> "On your account settings page, you can set whether you would like to
> allow routing to providers that may train on your data (according to
> their own policies). There are separate settings for paid and free
> models." ... "If you opt out of training in your account settings,
> OpenRouter will not route to providers that train."
> Source: https://openrouter.ai/docs/guides/privacy/provider-logging
> (read 2026-09-22)

Additional finding: for at least some specific free models (e.g. "Laguna
S 2.1"), OpenRouter's own model page states "we may use your inputs and
outputs to train and improve our models" as the applicable default.

**Verdict: default configuration disqualified; conditionally usable.**
OpenRouter is a router, not a first-party inference provider — the
effective data-use policy for any given free-tier request is whichever
downstream provider serves it, unless the account-level "disallow
providers that may train on inputs" toggle is enabled for free models (and
Zero Data Retention routing is selected). With that toggle on, only ZDR /
non-training-eligible free endpoints are used, which should satisfy the
no-train constraint — at the cost of a smaller and less predictable pool
of eligible free models (model availability shifts over time as OpenRouter
adds/removes free listings).

**Free-tier rate limits:** Not confirmed in this pass beyond "documented
per-model on each model's page" — OpenRouter free models generally carry
per-day message/request caps and are subject to availability of whichever
upstream provider is serving that slot; capacity is not guaranteed the way
a first-party free tier is. This variability is itself a downside for a
production async pipeline.

**Structured/JSON output:** `response_format` parameter is accepted and
passed through to the underlying model, but whether a specific free model
honors strict JSON schema depends on that model's own capability — not
uniformly guaranteed across OpenRouter's free pool.

---

### Together AI

**ToS / data-usage clause (verbatim):**
> "By choosing 'No', you are enabling Zero Data Retention ('ZDR') for your
> use of the Services. Under ZDR, your data and outputs are not stored,
> retained, or used for model training, product improvements, or any other
> purpose beyond the time required to process the specific request or
> transaction."
> — Together AI Terms of Service, §3.2
> Source: https://www.together.ai/terms-of-service (read 2026-09-22)

Together's privacy stance (opt-in-only training, ZDR toggle available to
all accounts) is actually good and would likely pass the no-train
constraint.

**Verdict: disqualified on the €0 constraint, not the no-train
constraint.** Together AI does not currently operate an ongoing free
inference tier — new accounts receive a one-time ~$5 trial credit, not a
sustained free allocation. Once that credit is exhausted the workload
would incur cost, which fails the "tier must be €0" hard requirement for
a recurring per-document job.
Source: https://together.ai/pricing (read 2026-09-22)

**Models / JSON mode:** Together hosts a broad catalog including small
fast open models and supports JSON mode; moot given the disqualification.

---

### GitHub Models

**Verdict: disqualified — product retired.** GitHub Models (playground,
model catalog, inference API, and bring-your-own-key) was **fully retired
on July 30, 2026**. New customers were cut off June 16, 2026; existing
customers/integrations stopped working after the July 30 shutdown.
Source: https://github.blog/changelog/2026-07-30-github-models-is-now-retired/
and https://github.blog/changelog/2026-07-01-github-models-is-being-fully-retired-on-july-30-2026/
(read 2026-09-22)

No further evaluation performed — there is nothing to integrate against.

---

## Summary table

| Candidate | No-train on free tier? | €0 ongoing tier? | Credit card? | Small/fast model fit | JSON/structured output | Verdict |
|---|---|---|---|---|---|---|
| **Cerebras** | Yes (not retained, not used to train) | Yes, 1M tokens/day | No | Llama 3.1 8B/70B — good fit | Yes, on llama3.1-8b/70b (strict schema) | **Recommended (top pick)** |
| **Groq** | Yes, contractual (§4.2 Services Agreement) | Yes | Not required (undocumented) | gpt-oss-20b/120b — good fit | Yes, strict json_schema on gpt-oss-20b/120b | **Recommended (close second)** |
| **OpenRouter (free models)** | No by default; yes if ZDR/no-train toggle enabled | Yes | Not required | Varies by routed model | Passed through; not guaranteed per free model | Conditional fallback only |
| **Mistral (Experiment tier)** | No by default; yes after manual opt-out | Yes (~1B tokens/mo) | Not required (undocumented) | mistral-small — plausible | Yes (La Plateforme JSON mode) | Conditional fallback only |
| **Google AI Studio / Gemini** | **No** — free tier trains, no opt-out | Yes | Not required | Gemini Flash — technically strong | Yes (responseSchema) | **Disqualified (no-train)** |
| **Together AI** | Yes (ZDR toggle, opt-in-only training) | **No** — trial credit only, not ongoing free | Unclear | Broad catalog | Yes | **Disqualified (€0)** |
| **GitHub Models** | N/A | N/A | N/A | N/A | N/A | **Disqualified (retired 2026-07-30)** |

---

## Caveats / follow-ups before committing

- Cerebras' exact privacy-policy sentence should be re-copied verbatim
  from https://www.cerebras.ai/privacy-policy directly (this research pass
  relied on third-party aggregator summaries plus the structured-outputs
  and pricing docs for Cerebras specifics — the Groq, Mistral, Together,
  and Google quotes above were pulled from first-party pages/help articles).
- Rate limits for Cerebras and Mistral free tiers are pulled partly from
  third-party trackers (pricepertoken.com, benchlm.ai) because the
  providers' own docs are not fully explicit about current numbers;
  confirm live values from the account dashboard before sizing the batch
  scheduler.
- OpenRouter's free-model pool changes over time and per-model policies
  differ; if OpenRouter is used as a fallback, the "disallow training
  providers" toggle state and the resulting available model list should be
  re-verified periodically, not assumed static.
- None of the free tiers researched offer an SLA; the "few minutes per
  document" budget should assume Cerebras/Groq's tight per-minute rate
  limits force sequential (not concurrent) batch calls, which is fine
  given the async job model but should be reflected in the scheduler
  design, not assumed away.
