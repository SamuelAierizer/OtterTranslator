# OtterTranslator — Web Service Plan

**Status:** Planning complete, no implementation started.
**Date:** 2026-08-06
**Context:** Turning the existing DOCX translation CLI into a self-hosted web service deployed via Coolify on a small VPS.

This document is self-contained. It captures the codebase analysis, every scoping decision and the reasoning behind it, the implementation plan, and the open questions that must be answered before building. A reader with no prior context should be able to pick up from here.

---

## 1. Starting point: what the repo contains

~700 lines of TypeScript, one commit (`5cf598f initial git release`), zero tests, CLI-only.

### Pipeline

`unzip → parse XML → serialize paragraphs to tagged text → translate → reconstruct runs → rezip`

| File | Role |
|---|---|
| `src/cli.ts` | Arg parsing, orchestration, ANSI progress bar, batch loop |
| `src/docx-handler.ts` | adm-zip load/save, XML part discovery, DOM cache |
| `src/xml-parser.ts` | Run merging, paragraph → tagged text serialization |
| `src/google-translator.ts` | Free Google endpoint client + bracket cleanup |
| `src/ollama-translator.ts` | Local LLM client, batch JSON mode, tag validation |
| `src/reconstructor.ts` | Tagged text → DOCX runs, style reapplication |
| `src/types.ts` | `TranslationBlock`, `CLIOptions` |

### What is genuinely good and should be preserved

- **Run merging** (`xml-parser.ts:21`) — solves the "split runs" problem where Word splits one word across multiple `w:r` nodes (`[Spu]` + `[berit]`). Most naive DOCX translators get this wrong.
- **The `[f1]…[/f1]` tag scheme** — sending lightweight bracket tags instead of raw XML to a translation engine. Repositionable across differing word orders, and survives translation far better than markup.
- **Save via `zip.updateFile`** (`docx-handler.ts:85`) — only the touched XML parts are rewritten; everything else in the archive survives byte-for-byte. Correct approach.
- **Tag validation with retry and fallback** (`ollama-translator.ts:24`) — reusable for the verification layer.

The engine is solid. It is not a product: no HTTP layer, no job model, no auth, no limits, no cleanup, and it writes progress bars to stdout and calls `process.exit` on failure.

### Known defects (identified during analysis, not yet fixed)

**Critical — visible document corruption:**

1. **Hyperlink text is never translated, and gets relocated.** `xml-parser.ts:79` iterates only direct `w:r` children of the paragraph. Anything wrapped in `w:hyperlink`, `w:ins` (tracked-change insertions), or `w:smartTag` is invisible to serialization. Then `reconstructor.ts:121-124` sends those elements to `preservedNodes`, and `reconstructor.ts:153` appends them at the **end** of the paragraph. Net effect: hyperlinked text stays in the source language *and* physically moves to the end of the paragraph.

2. **Inline images/objects move to the end of the paragraph.** Same mechanism — a `w:r` containing `w:drawing` or `w:object` is pushed to `preservedNodes` (`reconstructor.ts:118`) and appended last. An image sitting mid-sentence ends up after the text.

**Moderate:**

3. **Hardcoded Romanian→Hungarian prompts** in `ollama-translator.ts` at `:10` (constructor default), `:96` (batch system prompt), and `:263` (stripped-tag fallback) — directly contradicts the CLI's advertised language-agnostic behaviour. The Ollama engine silently ignores `--from`/`--to`.

4. **Non-Latin script detection is broken** for the same reason — `ollama-translator.ts:66` and `:204` gate on `/[a-zA-ZăâîşţĂÂÎŞŢ]/`, so Cyrillic, Greek, CJK, Arabic, etc. text is classified as "symbols only" and returned untranslated.

5. **Leftover `[DEBUG]` console logging** at `ollama-translator.ts:121-138`.

6. **Unhandled document parts** — `docx-handler.ts:33-37` only picks up `word/document.xml`, `word/header*.xml`, `word/footer*.xml`. Missing: `footnotes.xml`, `endnotes.xml`, `comments.xml`, SmartArt (`word/diagrams/`), and document metadata (`docProps/core.xml`). Text boxes *are* covered incidentally, since `getElementsByTagName('w:p')` recurses into `w:txbxContent`.

**Deployment-blocking:**

7. **Uncontrolled concurrency.** `cli.ts:247` fires `Promise.all` across a batch of 15 with only a 100ms sleep between batches. From a datacenter IP this is the fastest possible way to get the endpoint blocked.

---

## 2. Decisions

All decided in session on 2026-08-06.

| Question | Decision | Why |
|---|---|---|
| Audience | **Small known group** (~5–50 people) | Not public. Low volume is what makes the free Google endpoint survivable. |
| Auth | **Magic link by email**, against an allowlist | No passwords to manage or leak. Gives per-user identity for job history and quotas. |
| Translation backend | **Keep free Google endpoint**, add fallbacks/limiting | €0 constraint. Low volume makes blocking unlikely, though never guaranteed. |
| Behaviour when blocked | **Fail loudly, no fallback** | No paid backstop exists by definition at €0. Self-hosted LibreTranslate was ruled out by the 1 GB RAM limit anyway. Consistent, simplest v1. |
| LLM verification | **Auto-correct silently** | User just gets a better document; no report UI to build. |
| Budget | **Strictly €0** on APIs | Free tiers only. |
| Data sensitivity | **Somewhat — prefer no-train** | Business documents. Requires a free-tier LLM provider that does not train on API traffic. This is a hard constraint on provider choice. |
| VPS | **1–2 GB RAM, 1 vCPU** | The binding constraint on the entire architecture. |
| Document size | **≤2 MB / ~30 pages** | Small letters/reports/contracts. Load-bearing for the memory budget — do not raise casually. |
| Retention | **24 hours, then auto-purge** | Balance of re-download convenience vs. not hoarding colleagues' documents. |
| Fidelity fixes in v1 | **Hyperlinks + inline object position; defer footnotes/comments** | Relocation is visible corruption that generates complaints immediately. Footnotes/comments are additive and can wait. |
| Format scope | **DOCX only** | PDF/PPTX/XLSX not in scope. |

### Consequences of the 1–2 GB / 1 vCPU constraint

This rules things out cleanly and should not be revisited without new hardware:

- **No Redis, no Postgres.** SQLite + an in-process queue. Saves 200+ MB that isn't available.
- **Strictly one job at a time.** 1 vCPU is already saturated by xmldom parsing; concurrency only makes everything slower and raises OOM risk.
- **No self-hosted translation engine** (LibreTranslate/Argos needs ~2 GB plus per-language-pair models). No local LLM (needs ~8 GB minimum, and CPU inference would be hours per document).
- **No frontend build step.** Server-rendered HTML plus vanilla JS.

### Memory reasoning (why the 2 MB cap matters)

`adm-zip` loads the whole archive into a Buffer. DOCX XML compresses roughly 10:1. xmldom's DOM representation runs roughly 5–15× the size of the source XML string.

- A 2 MB upload → `document.xml` in the low single-digit MB → peak DOM on the order of 100 MB. **Fits comfortably.**
- A 5 MB upload → potentially 50 MB of XML → 250–750 MB of DOM. **Marginal to fatal on this box.**

Guard both the upload size *and* the decompressed part size, checked **before** parsing.

---

## 3. Target architecture

One Node process. No Redis, no Postgres, no frontend build.

```
Browser ──upload──▶ Fastify ──▶ SQLite (jobs table)
   │                              │
   └──poll /api/jobs/:id          ▼
                          in-process worker (serialized, 1 at a time)
                                  │
                    ┌─────────────┴─────────────┐
                    ▼                           ▼
            Google batch translate      LLM verify pass
            (multi-q, rate limited)     (batched, tag-guarded)
                    └─────────────┬─────────────┘
                                  ▼
                        /data/outputs/<id>.docx  ──24h cron──▶ purge
```

**Stack choices:**

- **HTTP:** Fastify + `@fastify/multipart`. Lighter than Express, better streaming multipart handling.
- **UI:** Server-rendered HTML, vanilla `fetch` polling for progress. The entire UI is an upload form, a progress bar, and a download link.
- **DB:** `better-sqlite3` — synchronous, near-zero overhead, single file on the volume. Tables: `users`, `sessions`, `magic_tokens`, `jobs`.
- **Queue:** A loop pulling the oldest `queued` row from SQLite. State persisted in the DB so a container restart resumes rather than loses work. Roughly 60 lines; the correct amount of machinery for 1 vCPU.
- **Email:** `nodemailer` over plain SMTP, configured by env var. Works with any free provider's SMTP or an existing mailbox — no vendor SDK, no lock-in.
- **Container:** Multi-stage `node:22-alpine`, non-root user.

### Engine refactor

Extract `src/engine/` as a pure library, decoupled from stdout and `process.exit`:

```ts
translateDocx(buffer: Buffer, opts: {
  from: string; to: string;
  onProgress?: (done: number, total: number, part: string) => void;
  signal?: AbortSignal;
}): Promise<Buffer>
```

Typed errors (`TranslationBlockedError`, `DocumentTooLargeError`, `MalformedDocxError`) instead of `process.exit`. `src/cli.ts` becomes a thin wrapper over the same library — the CLI keeps working, which preserves a fast local path for debugging fidelity bugs without going through the web UI.

Keep the translation backend behind a clean interface regardless of whether an alternative is ever used. It costs almost nothing now and turns a future swap to DeepL free tier or paid Google into a config change rather than a rewrite.

### Fidelity fixes

**Hyperlinks** (`xml-parser.ts:79`) — recurse into `w:hyperlink`, `w:ins`, `w:smartTag` containers rather than only visiting direct `w:r` children. Emit a container tag (e.g. `[h1]…[/h1]`) so the wrapper element, including its `r:id` relationship attribute, can be rebuilt intact during reconstruction.

**Inline object position** (`reconstructor.ts:153`) — use the pattern the codebase already established for `[br/]`: emit a positional placeholder (e.g. `[o1/]`) where the object sits, let it ride through translation, and reinsert the original preserved node wherever the placeholder ends up. Consistent with the existing tag design rather than bolted on.

**Cleanup** — remove `[DEBUG]` logs; parameterize the three hardcoded RO→HU prompts; replace the Latin-only regex script check with something that doesn't misclassify non-Latin scripts as untranslatable.

Each fix needs a fixture DOCX and a round-trip test. There are currently zero tests; these are where the first ones go.

### Rate-limit strategy

This determines whether the service works at all.

1. **Remove the `Promise.all`** at `cli.ts:247`. Replace with a serialized queue plus a token-bucket limiter.
2. **Batch via repeated `q` parameters** — `?q=para1&q=para2&…` on `translate_a/single`. Turns ~600 requests into ~30 for a 30-page document. **Unverified — see §5.** This is the single highest-leverage change if it holds.
3. **Circuit breaker** — on repeated 429/403, halt the job, mark it `blocked`, surface a clear message. Prevents one bad job from burning the shared IP for everyone.

### LLM verification

Runs after Google. Batches ~20 paragraph-pairs (source + translation) per call; the model returns corrected translations.

**The safety rule that makes silent auto-correction shippable:** the verifier may only improve, never corrupt. Every LLM-returned string passes through the existing tag validation (`ollama-translator.ts:24` — reuse it). On any tag mismatch, length mismatch, or parse failure, that paragraph silently keeps Google's output. Because corrections are invisible to the user, a verifier that quietly mangles formatting would be strictly worse than no verifier at all.

Skip verification for paragraphs that are pure numbers, single words, or under ~15 characters — meaningful call-volume reduction for free.

At roughly 15 RPM on a typical free tier, a 30-page document costs about 2–3 minutes of verification. Acceptable for an async job.

### Hardening

Non-negotiable once other people can upload:

- Validate the file is genuinely a DOCX — check for `[Content_Types].xml` and `word/document.xml`, not the file extension.
- **Zip-bomb guard:** read `entry.header.size` (uncompressed) and reject before extraction. A 200 KB upload can decompress to gigabytes and take the box down.
- Confirm `@xmldom/xmldom` does not resolve external entities on the pinned version — XXE is the obvious attack against a document parser.
- `--max-old-space-size=768` so the process fails predictably instead of being OOM-killed alongside everything else on the VPS.
- Per-user job rate limit; single-use, short-lived magic-link tokens; non-root container user.

---

## 4. Implementation phases

**Phase 0 — Verification spike (do first, ~half a day).** Three assumptions can each invalidate parts of the design. All are cheap to test and expensive to discover late. See §5.

**Phase 1 — Engine as a library.** Extract `src/engine/`, add typed errors and progress callbacks, keep the CLI working, fix hyperlinks and inline-object position, write the first tests with fixture documents.

**Phase 2 — Web service.** Fastify, SQLite schema, persisted job queue, magic-link auth, upload with validation, progress polling, download, 24h purge cron.

**Phase 3 — Verification layer.** Provider client, batching, tag-guarded correction with fallback to Google output.

**Phase 4 — Ship.** Multi-stage Dockerfile, healthcheck endpoint, Coolify config with a persistent volume for `/data`, env vars, structured logging. Coolify handles Traefik and Let's Encrypt.

Phases 1 and 2 are independent — Phase 2 can be built against a stub engine to stand the service up early.

---

## 5. Open items — verify before building

Three assumptions were made and should be tested rather than trusted:

1. **Does multi-`q` batching work on `translate_a/single`, and what is the response shape?** Reasonably likely, but the entire rate-limit strategy rests on it. If it fails, the fallback is low concurrency plus a token bucket, and blocking becomes materially more likely.

2. **Which free LLM tier genuinely does not train on API data?** Provider terms change; this was deliberately not asserted from memory. Someone needs to read the current terms for the candidate providers before committing. This is a hard constraint given the "somewhat sensitive / prefer no-train" decision. Candidates worth checking: Groq, Cerebras, Mistral, Google AI Studio.

3. **Does the Google endpoint respond at all from the target VPS's IP range?** Worth a single `curl` from the box before building anything on top of it. If that IP range is already burned, the plan needs reworking.

Also still unspecified (did not block planning, but will need answers):

- Which language pairs matter most. The hardcoded Ollama prompts suggest a real RO→HU use case.
- Whether an email-on-completion notification is wanted in addition to in-page progress polling (nearly free, since SMTP is already wired for magic links).

---

## 6. Honest risks

**The free Google endpoint is an undocumented internal API** (`translate_a/single?client=gtx`) accessed with a spoofed browser User-Agent (`google-translator.ts:14-22`). It can stop working with no notice and no recourse, and it is against Google's Terms of Service — a defensible position for a small internal tool, and not one if this ever grows or becomes public. The €0 constraint means there is no backstop when it breaks. Low volume makes it *likely* to keep working; nothing makes it *guaranteed*.

**Free-tier LLMs and confidential documents are in tension.** Most free tiers are paid for with your data. The "prefer no-train" decision narrows provider choice considerably and needs verification (§5.2) rather than assumption.

**Silent auto-correction hides failures.** The tag-validation guard is what keeps this safe. Do not relax it.

**Memory, not CPU, is the failure mode.** The 2 MB document cap and the decompressed-size guard are the two things standing between the service and an OOM kill. Treat raising them as an architectural change, not a config tweak.
