# GEM-1

> Section: 2026-09-26 — Answer-engine Gemini grounding (issue #929)

**Ruling GEM-1 — call the Gemini REST endpoint with plain `fetch`, not the `@google/genai` SDK.**
Both fix the tool-shape bug (the maintained SDK exposes `googleSearch: {}`; the REST API takes
`google_search`). A new SDK dependency means a lockfile regen and a fresh dependency-discipline
pass (registry/license/audit/leaf-override) for a single call site, when the sibling
`perplexity.provider.ts` / `openai.provider.ts` adapters in the same directory already call their
providers' REST APIs directly with `fetch` — no SDK — for exactly this reason ("per the task
constraint", their own file headers). Matching that pattern is the smaller, safer, more consistent
change: zero new dependencies, zero lockfile/audit surface, one fewer SDK version to track for
drift. Cost if wrong: a future Gemini REST response-shape change breaks this adapter without an SDK
maintainer's typed layer to catch it at compile time — mitigated by the defensive, untrusted-input
parsing already required of every other provider adapter in this file (`detectCitation` in
`provider.ts` is explicit about this contract).
