# Findings

Imported from Taiga's sandbox on 2026-11-13 and integrated into the main project.
All 22 findings are fixed. The descriptions below retain the original reproduction evidence;
each newly resolved finding names its fix and regression coverage. Provider tests use stubbed
HTTP responses and do not spend API credits. Live provider quality and account entitlements
remain external checks, not prerequisites for these regression fixes.

Final validation after deleting the sandbox: 170 unit/HTTP tests pass. Application build,
tooling TypeScript checks, a fresh frozen-lockfile install and the Playwright product-flow
test also pass. The main project has its own dependency directory.

Defects and risks found in the translation engine, tracked across sessions. Give each new finding
the next free ID (never reuse one) and place it in **Open** by severity. When fixing one, move it to
**Fixed** and name the regression test that now covers it.

**Severity:** *High* — content lost, misplaced or the file may not open. *Medium* — layout or
formatting silently degraded, or translation silently skipped. *Low* — cosmetic or unlikely.
**Evidence:** *Reproduced* — shown by running the engine. *Code reading* — inferred, not run.

Reproductions use `translateDocx` with a mock backend (no provider calls). "Kept in source" means
the paragraph failed tag validation and was written back untranslated, which is safe but visible.

## Open

None.

## Fixed in the backlog follow-up — 2026-11-13

### F-06 Footnote reference marks are deleted — High
**Fixed 2026-11-13.** All non-text runs and inline children are preserved as opaque placeholders, including body and note reference marks. Regression: `test/fidelity.backlog.test.ts` (all four reference types).

*Found 2026-11-13 · Reproduced · Pre-existing*
A run holding only `<w:footnoteReference>` has no visible text, so `processRun`
(`src/engine/xml-parser.ts`) drops it. Every footnote number in the body disappears while the notes
stay in `footnotes.xml`. `<w:footnoteRef/>` marks inside the notes, and endnotes, are presumably
affected the same way (not yet run).
Repro: `Claim` + footnote-reference run + ` continues.` → `CLAIM CONTINUES.`
Likely fix: treat reference runs like drawings, as `[oN/]` placeholders.

### F-07 Text boxes are sent for translation but never updated — High
**Fixed 2026-11-13.** Drawing placeholders keep live node references; reconstruction runs from descendants to ancestors so translated text boxes are cloned only after updating. Mixed text/drawing runs use live children as well. Regression: `test/fidelity.backlog.test.ts` (non-identity text-box translation).

*Found 2026-11-13 · Reproduced · Pre-existing*
`extractBlocksFromDOM` collects nested paragraphs inside `w:txbxContent` as separate blocks. The
outer paragraph, however, is rebuilt from a clone of the drawing run taken *before* translation,
so the inner block is written into a detached node. The provider is billed, and the output keeps
the source text. The README lists text boxes as supported. The existing `text-box.docx` smoke test
uses the identity backend, so it cannot notice.

### F-09 Content controls and simple fields are rebuilt incompletely — High
**Fixed 2026-11-13.** Container attributes are copied completely; SDTs retain their properties and content wrapper. Nested inline containers are processed recursively. Regression: `test/fidelity.backlog.test.ts` (content-control wrapper and field instruction).

*Found 2026-11-13 · Reproduced · Pre-existing*
`reconstructParagraph` (`src/engine/reconstructor.ts`) rebuilds containers from the metadata saved
in `processContainer`:
- `w:sdt` loses `w:sdtPr` and `w:sdtContent`. Runs are placed directly inside `w:sdt`, which the
  schema does not allow, so Word may report the file as damaged. `metadata.sdtPr` is saved but never
  used.
- `w:fldSimple` loses its `w:instr` attribute. Repro: `<w:fldSimple w:instr=" PAGE ">` →
  `<w:fldSimple>`, which leaves a dead field.

### F-19 A transient 429 is treated as quota exhaustion — Medium
**Fixed 2026-11-13.** Transient rate limits retry up to three attempts with abortable Retry-After/backoff waits. Only confirmed quota errors allow initial fallback; the selected provider stays fixed for the document. Failed attempts retain character reservations. Regression: `test/backend.backlog.test.ts` (transient and sustained 429s, authorization errors, Retry-After).

*Found 2026-11-13 · Reproduced (stubbed fetch) · Pre-existing*
`MicrosoftTranslatorBackend` throws `QuotaExhaustedError` on the first 429/403. `CompositeBackend`
treats that as "primary used up" and re-sends the whole batch to Google. One momentary 429 moved 8
paragraphs to Google: that spends the smaller shared credit, and documents come out with mixed
provider terminology that varies from run to run. Fix direction: separate transient (429: back off,
honour `Retry-After`, retry) from permanent (quota exceeded). Consider keeping one provider per
document.

### F-21 Rate limiter counts requests; Azure meters characters in a sliding window — Medium
**Fixed 2026-11-13.** Microsoft uses a shared character-weighted sliding-minute limiter (33,000 characters), including retries, with 30,000-character requests. The monthly ledger remains a calendar-month bucket. Regression: `test/backend.backlog.test.ts` (100 queued acquisitions under a virtual clock). Limits verified against [Microsoft service limits](https://learn.microsoft.com/en-us/azure/ai-services/translator/service-limits).

*Found 2026-11-13 · Simulated · Pre-existing*
`RateLimiter` is a token bucket of 100 requests/s. `docs/providers.md` records that Azure enforces
"a sliding hourly rate" on characters. A virtual-clock simulation (3,000 × 80-char paragraphs,
120 ms latency, illustrative 33,000 chars/60 s budget) had today's limiter reach 40,000 chars in
the worst 60 s window, which would trigger 429s and F-19. A character-weighted sliding-window log
limiter (deque of timestamp/chars, O(1) amortised) never exceeded the budget. Take Azure's actual
figure from its service-limits page before implementing. The monthly quota is a calendar-month
bucket on purpose, matching billing; do not make that a sliding window.

### F-22 Text is XML-escaped before it goes to plain-text providers — Medium
**Fixed 2026-11-13.** Serialization sends raw punctuation and entities as plain text; reconstruction assigns textContent without entity decoding. Literal opening brackets use opaque placeholders. Regression: `test/fidelity.backlog.test.ts` (payload punctuation and literal entity text). Live translation quality remains unverified.

*Found 2026-11-13 · Reproduced (payload) · Pre-existing*
`serializeParagraph` applies `escapeXml` to text, so providers receive
`He said &quot;don&apos;t&quot; &amp; left &lt;now&gt;.` for `He said "don't" & left <now>.`:
54 billed characters instead of 29. Google is called with `format: 'text'` and Microsoft in its
plain-text default, so entities are not interpreted. How real providers translate text containing
entities is unverified and needs a live check. The escape layer is not needed for XML correctness,
because reconstruction writes through `textContent`. The only character the tag format needs
escaped is `[` (see F-13).

### F-20 One HTTP request per paragraph — Medium
**Fixed 2026-11-13.** Both backends greedily pack paragraphs into array requests within character and item limits, check response cardinality, and reassemble split paragraphs positionally. Regression: `test/backend.backlog.test.ts` (one request for multiple texts on each provider and short-response rejection).

*Found 2026-11-13 · Reproduced (stubbed fetch) · Pre-existing*
A 600-paragraph document made 600 Microsoft requests, although the v3 API accepts an array of texts
per request (within the 50,000-character request limit). Google v2 also accepts several `q`
values. The comment in `translateDocx` says batching is the backend's job, but no backend batches.
Packing in document order (greedy, no reordering, so alignment stays positional and
deterministic) cut requests 100× in simulation. Latency, not throughput, is what improves.

### F-08 Inline items without text are dropped or flattened — Medium
**Fixed 2026-11-13.** Tabs and whitespace-only text are retained; non-text inline elements and field instructions/markers use preserved nodes, including mixed text/non-text runs. Regression: `test/fidelity.backlog.test.ts` (symbols, hyphens, field markers/instructions and formatted tabs).

*Found 2026-11-13 · Reproduced · Pre-existing*
`processRun` keeps only `w:t`, `w:br`/`w:cr`, `w:tab` and drawings. Reproduced losses:
- Tab-only runs with their own formatting, e.g. an underlined form blank: `Name:→Date` →
  `NAME:DATE`.
- `w:sym` (e.g. a checkbox glyph), `w:noBreakHyphen` (`e‑mail` → `EMAIL`) and `w:softHyphen`.
- Complex fields (`w:fldChar` / `w:instrText`, e.g. PAGE in a footer): only the cached result text
  survives, so the field becomes static text.

### F-10 Tabs are not validated — Medium
**Fixed 2026-11-13.** Validation compares tab counts in addition to tags. Regression: `test/fidelity.backlog.test.ts` (provider changes a tab to a space).

*Found 2026-11-13 · Reproduced (simulated provider) · Pre-existing*
Tabs travel as raw `\t` characters, and `validateTags` does not count them. A provider that turns a
tab into a space, or drops it, passes validation: `KEY→VALUE` becomes `KEY VALUE` or `KEYVALUE`.
Options: count tabs in `validateTags`, or carry tabs as a tag (e.g. `[tab/]`). A tag would also
need the backend and review prompts updated.

### F-12 Marker repair helper is not used by the live backends — Medium
**Fixed 2026-11-13.** Both live backends normalize bracket spacing before returning translations; the pipeline also normalizes before final validation. Regression: `test/backend.backlog.test.ts` (both providers return spaced tags).

*Found 2026-11-13 · Reproduced (simulated provider) · Pre-existing*
`cleanTranslatedBrackets` in `src/engine/tags.ts` repairs provider spacing such as `[br /]` and
`[ f1 ]`. Only the unused legacy `src/engine/google-translator.ts` calls a copy of it;
`ms-translator.ts` and `google-cloud.ts` do not. Such paragraphs fail validation and are kept in
source. Note the helper does not fix case: `[BR/]` is still rejected.

### F-11 Provider spaces around `[br/]` end up at line edges — Low
**Fixed 2026-11-13.** Normalization restores the original whitespace immediately around breaks, removing provider-added line-edge spaces while retaining intentional spaces. Regression: `test/backend.backlog.test.ts` (F11/F12 whitespace cases).

*Found 2026-11-13 · Reproduced (simulated provider) · Pre-existing*
`Line one [br/] Line two` passes validation. The next line then starts with a space and the
previous one ends with one. This is visible as a slight indent.

### F-13 Tag-like text typed in a document is misread — Low
**Fixed 2026-11-13.** Literal opening brackets travel as opaque placeholders and are restored as text in the current formatted run. They cannot collide with generated tags or trigger entity decoding. Regression: `test/fidelity.backlog.test.ts` (literal markers), plus the extraction-idempotence property test.

*Found 2026-11-13 · Reproduced · Pre-existing*
Serialization does not escape brackets.
- A literal `[br/]` in the text becomes a real line break.
- A literal `[f1]` collides with the generated tag. The paragraph then fails validation, and even
  the kept-in-source rebuild drops the literal and makes the following text bold.

### F-14 Image-only paragraphs are sent to the provider — Low
**Fixed 2026-11-13.** The translatable-text check ignores all internal tags, including object placeholders. Image-only paragraphs remain untouched. Regression: `test/fidelity.backlog.test.ts` (image-only extraction).

*Found 2026-11-13 · Reproduced · Pre-existing*
A paragraph containing only an inline image serializes as `[o1/]`, which passes the
"has text" check in `extractBlocksFromDOM`. It costs quota and a validation round for nothing.
This is the same class as F-04, left out of that fix to keep its scope narrow.

### F-15 Microsoft backend may split a paragraph inside a tag — Low
**Fixed 2026-11-13.** The shared splitter treats tags and Unicode code points as indivisible tokens, then reassembles chunks in order. Regression: `test/backend.backlog.test.ts` (long paragraph with a boundary-adjacent format tag and emoji).

*Found 2026-11-13 · Code reading · Pre-existing*
`MicrosoftTranslatorBackend.splitText` cuts paragraphs longer than 50,000 characters at a fixed
length, possibly inside a tag such as `[b` | `r/]`. The halves are translated separately.
Validation would most likely catch it and keep the paragraph in source.

### F-16 Toolchain pins cannot be installed as declared — Environment
**Fixed 2026-11-13.** Aligned `.tool-versions` and package.json on pnpm 10.34.8; pinned Node 24.18.0 locally, documented current Corepack, updated Docker to Node 24, and regenerated the lockfile with multipart 10.1.8. A clean `pnpm install --frozen-lockfile` succeeded using Corepack 0.34.6 with signature verification enabled. The installed old Corepack lacked the current registry signing key; current registry checks found multipart 10.1.7 available, superseding the sandbox observation.

*Found 2026-11-13 · Reproduced · Environment*
- `package.json` pins `pnpm@10.34.9`. Corepack refuses it: the release exists on the registry but
  has no signature. The signature check was **not** bypassed.
- `.tool-versions` pins `pnpm 12.20.0`, newer than the registry's `latest` (12.18.0) at the time.
- `pnpm-lock.yaml` pins `@fastify/multipart@10.1.7`, which the registry does not have.

The historical workaround is retired. Follow the main README setup and use the committed lockfile.

## Fixed in the sandbox

### F-01 Merging runs moved text ahead of line breaks — High
*Found and fixed 2026-11-13*
`normalizeParagraph` merged a same-formatted neighbour run by appending its text to the *first*
`w:t` of the current run, but its breaks to the end. So `Line one⏎` + `Line two` became
`Line oneLine two⏎`. It also skipped a run after each merge.
Fix: absorbed content is appended in order, and text is joined only onto a trailing `w:t`.
Tests: `test/fidelity.line-breaks.test.ts`.

### F-02 Any paragraph with a line break crashed the whole job — High
*Found and fixed 2026-11-13*
`parseTranslatedText` read `match[8]` for `[br/]`, but the pattern had only six groups. A
top-level `[br/]` fell into the formatted-run branch and threw `TypeError`, which failed the
document. A `[br/]` inside `[fN]` or `[hN]` was instead written out as literal text. Break-only runs
and `w:cr` were dropped, and page/column breaks were not distinguished from line breaks.
Fix: a flat tokenizer plus an in-order run builder, with original break elements restored by
position. Tests: `test/fidelity.line-breaks.test.ts`.

### F-03 Formatting inside hyperlinks was written as literal tags — High
*Found and fixed 2026-11-13 (same root cause as F-02)*
The container pattern swallowed its contents as plain text. Underlined link text came out as
`[f1]website[/f1]`, with the underline lost. The existing hyperlink test only checked that
"website" appeared. Tests: `test/fidelity.line-breaks.test.ts` (hyperlink cases).

### F-04 Break-only paragraphs were sent to the provider — Medium
*Found and fixed 2026-11-13 · Regression introduced by the F-01/F-02 fix*
Once break-only runs were kept, a paragraph holding only a page break serialized as `[br/]` and was
sent for translation. That cost quota and counted as "kept in source" when the provider altered it.
Fix: `extractBlocksFromDOM` ignores `[br/]`, and the `[hN]` container tags around it, when deciding
whether a paragraph has text. The property test found the container case (`[h1][br/][/h1]`, a link
around a break) after the first fix. Image-only paragraphs were subsequently fixed under F-14.
Tests: `paragraphs holding only breaks are left alone and never sent to the translator`, and the
extraction property in `test/fidelity.property.test.ts`.

### F-05 Batch results were aligned by position without a per-batch check — High
*Found and fixed 2026-11-13 · Pre-existing*
`translateDocx` checked only the grand total. A batch returned one short followed by one returned
one long passed: one translation was lost and every later paragraph silently received its
neighbour's text. Current backends build results per item, so they are not known to trigger it.
Fix: each batch must return exactly as many results as were sent. Otherwise the job stops with
`TranslationBlockedError` before further provider calls.
Tests: `test/engine.batch-alignment.test.ts`.

### F-17 Tag validation counted tags but did not check their order — Medium
*Found and fixed 2026-11-13 · Pre-existing*
`validateTags` compared tag counts and ID sets only. The tags form a nested-bracket (Dyck)
language, so replies such as these were accepted and silently misapplied formatting or links:
- `[/f1]word[f1]`
- crossed `[f1]..[f2]..[/f1]..[/f2]`
- `[/h1]link[h1]`

In a mutation test, 36% of accepted tag-moved replies were broken.
Fix: `isWellFormed` in `src/engine/tags.ts` is a linear stack check:
- closers must match the innermost open tag;
- format runs never nest in each other;
- nothing is left open at the end.

Well-formed rearrangements are still accepted, so translators can reorder words.
Tests: `test/fidelity.tag-structure.test.ts` covers 6 broken replies, 7 legitimate rearrangements,
nested containers and an end-to-end fallback. `test/fidelity.property.test.ts` checks that every
accepted tag move rebuilds safely; with the check removed, 1,147 of 1,500 seeds fail it.

### F-18 Paragraph extraction was quadratic and blocked the server — High
*Found and fixed 2026-11-13 · Pre-existing*
`extractBlocksFromDOM` iterated xmldom's *live* `getElementsByTagName('w:p')`. Reading `.length`
after any DOM change re-walks the whole document, and run merging changes it on nearly every
paragraph. Timings: 2,000 paragraphs took 27 s; 4,000 took 86 s. A full 2,000-paragraph job blocked
the in-process server's event loop for 18.5 s.
Fix: the list is snapshotted once. 3,000 paragraphs now extract in well under a second, with
identical output.
Test: `test/engine.extraction-performance.test.ts`. It took 39 s before the fix against a 3 s
bound.

## Evaluated approaches

### Sliding windows over document text — not recommended
*Evaluated 2026-11-13*
- **Overlapping windows for context:** each paragraph would be translated more than once, the
  copies would need merging, and every overlapped character is billed. That makes output less
  deterministic, not more. MT APIs have no "context only, don't translate" field. If context is
  ever wanted, it belongs in the optional LLM review as read-only neighbouring text.
- **Splitting long paragraphs (F-15):** windows cut at arbitrary positions, including inside tags.
  The right tool is splitting at token boundaries from the tag tokenizer, preferably at sentences.
- **Monthly quota:** stays a calendar-month bucket to match provider billing. Sliding windows do
  fit *rate pacing*; see F-21.

### Property-based round-trip testing — adopted
*Evaluated 2026-11-13 · In the suite as `test/fidelity.property.test.ts`*
A dependency-free, fixed-seed generator builds 1,500 random paragraphs on every run. They mix
runs, breaks, tabs, page/column breaks, `w:cr`, hyperlinks, formatting and entities. Checked
properties:
- a paragraph is extracted exactly when it has text;
- an identity round trip is exact;
- extraction is idempotent;
- a tag-preserving translation keeps the structure;
- every tag arrangement the validator accepts rebuilds without losing content.

The original generator excludes F-08 cases; dedicated backlog regressions now cover them. A 40,000-paragraph exploratory run also passed. On failure, the
test names the seed; `paragraphXml(seed)` reproduces the input.
