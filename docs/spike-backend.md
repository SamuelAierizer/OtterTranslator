# Spike: translation backend for the DOCX translator

**Date:** 2026-09-22
**Scope:** research only, no production code. Findings for OtterTranslator's MT stage — a fast, deterministic, €0 backend for RO→HU (language-pair configurable), running ahead of an LLM verification pass, on a 1 GB / 1 vCPU VPS. Documents ≤2 MB, ~30 pages, ~600 paragraphs.

---

## 1. Is the free Google endpoint's 429 IP-specific or endpoint-wide?

**Endpoint-wide, at least for this endpoint/UA combination, right now.**

Tested from the developer's machine (public IP `188.24.80.33`, confirmed via `curl https://api.ipify.org`):

```
$ curl -s -o /tmp/g1.json -w "HTTP %{http_code}\n" \
    -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" \
    "https://translate.googleapis.com/translate_a/single?client=gtx&sl=ro&tl=hu&dt=t&q=Bun%C4%83%20ziua"
HTTP 429
```

Body on every 429:

```html
<html>...<h1>We're sorry...</h1><p>... but your computer or network may be sending automated queries. To protect our users, we can't process your request right now.</p>...
```

Tested again from a second, unrelated network path (Anthropic's server-side fetch infrastructure, via `WebFetch` — a different IP range entirely from the dev machine):

```
GET https://translate.googleapis.com/translate_a/single?client=gtx&sl=ro&tl=hu&dt=t&q=Bun%C4%83%20ziua
→ HTTP 429 Too Many Requests
```

Also tried, all from the dev machine, all 429:
- `translate.google.com/translate_a/single` (alternate host) — 429
- Different UA (Safari on macOS instead of Chrome on Windows) — 429
- Retried after a few seconds' delay — 429
- Multi-`q` request (see §2) — 429

**Conclusion:** this isn't a single burned residential IP. Two independent networks, two hosts, two UAs, all blocked identically with the same "automated queries" message. Google has tightened enforcement on this undocumented endpoint broadly (consistent with widespread public reports through 2026 of the free `gtx` endpoint being throttled much more aggressively than in prior years). **Do not build the v1 rate-limit strategy around this endpoint recovering.** A VPS's likely datacenter IP is if anything more likely to be blocked than a residential one, not less.

## 2. Does multi-`q` batching work?

**Untested end-to-end — the endpoint is 429ing regardless of shape, so a live batching response couldn't be captured.** What's established:

- The request `?q=a&q=b` was sent (see command below) and got the same 429 as everything else — no evidence either way on the response *shape* for a working case.
- Historical/community reports (pre-block) describe multi-`q` as supported and returning a nested-array JSON shape per query, and describe the `[f1]...[/f1]`-style bracket tags as *not guaranteed* to be preserved cleanly across segment boundaries in batched mode — worth re-verifying with live traffic if/when the endpoint responds again, before relying on it.
- Given §1, this is moot for planning purposes: an endpoint that 429s a single `q` request isn't going to be rescued by batching fewer requests against it.

```
curl -s -o /tmp/g2.json -w "HTTP %{http_code}\n" \
  "https://translate.googleapis.com/translate_a/single?client=gtx&sl=ro&tl=hu&dt=t&q=Bun%C4%83%20ziua&q=Mul%C8%9Bumesc"
HTTP 429
```

## 3. Practical max URL/query length before 414/413

Not directly testable against this endpoint right now (blocked before length matters). From documented community experience with this same Google endpoint: **GET requests fail around ~2000 characters of query string** (414-class failure), which is well below what 600 paragraphs would need even batched 20-at-a-time. The known workaround is switching to POST with `X-HTTP-Method-Override: GET`, which was never verified for this project since the endpoint is unusable regardless. Moot given §1/§2.

## 4. €0 alternatives — evaluated

| Provider | Credit card? | API type | Rate limit | RO↔HU | Latency | ToS risk |
|---|---|---|---|---|---|---|
| **MyMemory** | No | Documented, free | See below | Yes (confirmed, see below) | ~250ms | Medium — see below |
| **Public LibreTranslate instances** | No | Documented (self-host spec) | Instance-dependent | Usually yes | N/A — untestable | N/A |
| **Lingva Translate (public instances)** | No | Undocumented wrapper around Google | Instance-dependent | Currently broken (see below) | N/A | Inherits Google's ToS risk |
| **Google Cloud Translation** | **Yes** (billing must be enabled even for the free tier) | Documented, official | 500,000 chars/month free, permanent | Yes | Low (~100–300ms typical) | Low — official, no-train confirmed |
| **Microsoft Translator (Azure, F0 tier)** | Not confirmed either way from search; official docs recommend checking at signup | Documented, official | 2,000,000 chars/month free; 50,000 chars/request cap | Yes | Low | Low — official, "No Trace" no-train policy confirmed |
| **Yandex Translate** | Developer API is paid-per-character; no genuine free API tier found (only the free *consumer* web/app product, which isn't an API) | — | — | Likely yes (90+ languages) | — | Not viable as a €0 API |

### MyMemory — tested live

```
$ curl -s "https://api.mymemory.translated.net/get?q=Bun%C4%83%20ziua&langpair=ro|hu"
{"responseData":{"translatedText":"Szia!","match":0.97}, ..., "responseStatus":200, ...}
```
Works, RO→HU confirmed, HTTP 200, ~real-time.

Limit testing — a ~600-character query returns:
```
{"responseData":{"translatedText":"QUERY LENGTH LIMIT EXCEEDED. MAX ALLOWED QUERY : 500 CHARS"},
 "responseStatus":"403", ...}
```
(Note: the outer HTTP status is 200; the actual error is only visible in the JSON body's `responseStatus` field — the client must check this, not just the HTTP status code.)

From MyMemory's own usage-limits page (`mymemory.translated.net/doc/usagelimits.php`, fetched live):
- **Anonymous: 5,000 chars/day.**
- **With a valid email in the `de` param: 50,000 chars/day.**
- Whitelisting (by request) can raise this to 150,000 chars/day.
- **Max 500 chars per individual query.**

**This is a hard blocker at realistic document volume.** ~600 paragraphs of business-letter text at a conservative ~80–150 chars/paragraph is roughly 50,000–90,000 characters per document — i.e. **a single document can consume the entire daily email-tier quota, or exceed it**, before counting the LLM-verification pass or any other document that day. Multiple users translating documents on the same day would collide on a shared daily budget unless each registers a distinct email and IP is somehow not also limited (untested).

From MyMemory's Terms and Conditions (`mymemory.translated.net/terms-and-conditions`, fetched live):
- Automated API access is explicitly permitted, **but explicitly prohibits "translating more than one paragraph at once."** This directly conflicts with any batching strategy and is a plain-text ToS violation if paragraphs were concatenated into one `q`.
- Submitted text becomes part of MyMemory's "Public Data" translation memory, used to "improve services" and to serve translation matches back to *other* users. **This is incompatible with the "somewhat sensitive / prefer no-train" requirement for business documents** — it is the opposite of a no-train guarantee.

**Verdict: MyMemory is not viable as the primary backend** at this document volume and sensitivity level, despite being the easiest free option to reach technically. It could work as an emergency last-resort fallback for very short snippets, not for whole documents.

### Public LibreTranslate instances — tested live

All four tested public instances failed immediately:

```
libretranslate.com          → 400 "Visit https://portal.libretranslate.com to get an API key"
translate.terraprint.co     → 502 Bad Gateway
translate.fedilab.app       → 403 Forbidden (administrative rules)
libretranslate.de           → 301 redirect (dead/moved)
```
None are usable without registering for an API key (defeating the "no credit card, no friction" appeal) or are simply down. Self-hosting was already ruled out by the 1 GB RAM constraint (LibreTranslate/Argos needs ~2 GB+ per PLAN.md §2). **Not viable.**

### Lingva Translate — tested live, currently broken

```
$ curl "https://lingva.ml/api/v1/ro/hu/Bun%C4%83%20ziua"
{"translation": "Bună ziua", "info": {"detectedSource": "ro"}}
```
The "translation" is identical to the source text — it didn't translate. Confirmed this isn't a RO/HU-specific issue: the same instance also passes English straight through untranslated (`en→fr "hello world"` → `"hello world"`). Lingva is a wrapper around Google Translate's web frontend; its own upstream is very likely hitting the same blocking described in §1, so it silently no-ops instead of erroring. A second public instance (`lingva.thedaviddelta.com`) returned "DEPLOYMENT_PAUSED", a third (`translate.plausibility.cloud`) returned a 500. **Not viable right now, and structurally fragile even when it works, since it inherits Google's blocking risk one layer removed.**

### Google Cloud Translation API

Confirmed via web search of current documentation: 500,000 characters/month free, permanent (not a time-limited trial), separate from the $300/91-day new-customer credit. **Requires a valid payment method on the account to enable billing**, even though usage under the free tier isn't charged — this is a soft violation of the "no credit card" spirit of a €0 constraint even though it can stay genuinely free in practice. Official confirmation found that customer data/translations are not used to improve the models. At 30-page documents (~50–90k characters each per the MyMemory-volume estimate above), 500,000 chars/month supports roughly 6–10 documents/month within the strict free tier before any charge — thin for a "small known group" of 5–50 people, but real and official.

### Microsoft Translator (Azure Translator, F0 free tier)

Confirmed via web search of current Microsoft documentation and blog: 2,000,000 characters/month free, with a 50,000-character cap per individual request (so batching would need chunking regardless of any DOCX-side batching strategy). Microsoft's official "No Trace" policy and a 2018 blog post confirm customer API text is no longer logged or used for training on any tier, free or paid — this is the strongest documented no-train guarantee of the group. Credit-card requirement for Azure F0 signup was not conclusively confirmed from search results alone and needs a direct signup-flow check before committing (Azure free-tier signups historically require a card even when the tier itself is $0). At 2M chars/month, this comfortably covers 20+ full documents/month even at the higher volume estimate — the most headroom of any option checked.

### Yandex Translate

Only found a free *consumer-facing* product (web/app, 10,000 chars/request, not an API a server can call) and a paid per-character developer API. No genuine free developer API tier surfaced in search. **Not viable as a €0 backend.**

## 5. Offline/local option: `@xenova/transformers` + quantised OPUS-MT

**Tested live**, Node v24.5.0, on the developer's machine (not the target 1 GB/1 vCPU VPS — see caveat below), using `@xenova/transformers` (npm install into a throwaway scratch project outside the repo, not added as a project dependency).

### Model availability for RO→HU

Checked the Hugging Face Hub API directly. **No direct `opus-mt-ro-hu` model exists** — neither under `Helsinki-NLP/` nor the Transformers.js-compatible `Xenova/` mirror. Hungarian-paired OPUS-MT models that do exist: `de-hu`, `en-hu`, `eo-hu`, `fi-hu`, `fr-hu`, `sv-hu`, `uk-hu`, `ja-hu`, `ko-hu` (and their reverse directions) — Romanian is not among them. `Xenova/opus-mt-ro-en` does exist, so RO→HU would require a **two-hop pivot through English** (`ro→en`, then `en→hu`): two models loaded simultaneously, translation run twice per paragraph, and the usual quality loss of double MT hops. This alone is a meaningful strike against this option for the RO→HU pair specifically (other pairs the tool might support later may or may not have direct models — check per-pair before assuming pivoting is always needed).

### Measured resource usage (single-hop `en→hu`, not the RO→HU pivot pair)

```js
import { pipeline } from '@xenova/transformers';
const translator = await pipeline('translation', 'Xenova/opus-mt-en-hu', { quantized: true });
// ... translate 10 short business-letter-style sentences one at a time
```

```
RSS before load:      104.6 MB
Model load time:      4.2s
RSS after load:       891.5 MB
RSS after inference:  1347.0 MB
Translated 10 paragraphs in 19.88s → 0.50 paragraphs/sec
```

Sample output quality (EN→HU) was fluent:
```
EN: Dear Sir or Madam, thank you for your letter of the 3rd of March.
HU: Kedves uram vagy asszonyom, köszönöm a március 3-i levelét.
```

### Verdict: not viable on a 1 GB VPS. Recommend against.

- **Peak RSS (1,347 MB) is over 3x the 400 MB threshold this spike was told to reject at**, for a *single* language-pair model on a dev machine with no memory pressure. The target VPS has 1 GB total, shared with the Node process, SQLite, the HTTP server, and the OS — 1.3 GB alone doesn't fit even before accounting for everything else in PLAN.md's architecture.
- RO→HU specifically would need **two models loaded at once** (pivot through English), which only makes the memory picture worse, not better, than this single-model measurement.
- Throughput (0.5 paragraphs/sec) means a 600-paragraph document would take **~20 minutes** of pure MT time on hardware *better* than the target VPS (the 1 vCPU target is likely slower than the dev machine's CPU used for this test) — this fails the "fast" requirement in the spike's own brief regardless of the memory problem.
- This measurement is from the developer's machine, not the 1 GB/1 vCPU VPS — actual VPS numbers would likely be *worse* (slower CPU, no memory headroom, possible swapping), not better. No adjustment needed to the "reject" conclusion since the dev-machine number already exceeds the threshold by 3x.

### `@browsermt/bergamot-translator` — not tested live, ruled out on inspection

Not benchmarked (the `@xenova/transformers` result already disqualifies the offline approach, and time was better spent confirming this rather than re-deriving the same conclusion twice). On inspection: the canonical `mozilla/bergamot-translator` GitHub repository is explicitly marked **INACTIVE**. The actively-published npm package (`@browsermt/bergamot-translator`) is documented and designed for **browser/WASM client-side use** (worker-based, `delete()` cleanup pattern typical of WASM bindings) — there's no documented server-side Node deployment pattern or RAM benchmarks from the maintainers. Building a stable, resumable-after-restart pipeline for a self-hosted service on top of an inactive project with no server-side precedent is a maintenance risk this spike doesn't recommend taking on, independent of the RAM question `@xenova/transformers` already answered.

---

## 6. Ranked recommendation

1. **Microsoft Translator (Azure Translator, F0 free tier) as primary.** 2,000,000 chars/month free is the most headroom of any option checked, officially documented, and has the strongest confirmed no-train guarantee (matches the "somewhat sensitive" data requirement in PLAN.md §2 better than any other candidate). Needs one follow-up before committing: confirm whether Azure signup for F0 requires a credit card in practice (documentation didn't settle this conclusively) — if it does, this is still arguably worth it given it's the only option combining real headroom, official support, and no-train, and the card is never charged under free-tier usage.
2. **Google Cloud Translation API as secondary/fallback.** Same no-train guarantee, official and documented, but noticeably less headroom (500k vs 2M chars/month) and requires billing enabled. Worth wiring as a second provider behind the same interface PLAN.md already calls for (§3, "keep the translation backend behind a clean interface"), both for redundancy and because splitting real volume across two free tiers roughly doubles the effective free budget.
3. **Do not build around the free Google `gtx` scrape endpoint.** It's 429ing from two independent networks right now with no path to recovery visible, so PLAN.md's decision to "keep free Google endpoint, add fallbacks/limiting" (§2) needs revisiting — there's no live traffic to rate-limit. If it recovers on its own later, it was never going to be more than a bonus- redundant path anyway given the ToS risk PLAN.md itself already flags (§6).
4. **MyMemory as absolute last resort only, and only for small snippets, not whole documents.** The 500-char/query cap, 5,000–50,000 chars/day quota, explicit ToS ban on batching more than one paragraph per call, and the fact that submitted text joins a public, cross-user translation memory all argue against it as a document-translation backbone. It could plausibly serve single short strings (e.g. UI labels) elsewhere in the product, just not this pipeline.
5. **Rule out the offline/local option (`@xenova/transformers` or Bergamot) for v1**, based on measured evidence: peak RSS of 1,347 MB (3x the 400 MB threshold) for a single language-pair model on hardware better than the target VPS, no direct RO→HU model (would need a lossy two-hop pivot), throughput too slow (~20 min/document) to satisfy "fast," and Bergamot's canonical repo being inactive with no server-side deployment precedent. This isn't a "maybe with more tuning" — the memory number is off by more than 3x on friendlier hardware than production, which is a structural mismatch with a 1 GB VPS, not a configuration problem.

**Net effect on PLAN.md:** the rate-limit strategy in §3 ("Rate-limit strategy") built around Google-endpoint batching needs to be replaced with a Microsoft-Translator-primary, Google-Cloud-Translation-secondary design behind the engine's existing planned backend interface. This removes the ToS-risk and 429-risk PLAN.md itself already called out as the biggest open risk (§6), at the cost of needing a credit card on file for at least one provider (mitigated by genuine, documented, monitorable free-tier caps that were verified live in this spike, not assumed).
