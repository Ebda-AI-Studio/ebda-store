# LEDGER-2026-09-26-Answer-engine-Gemini-grounding-issue

> Section: 2026-09-26 — Answer-engine Gemini grounding (issue #929)

Ruling LEDGER-2026-09-26-Answer-engine-Gemini-grounding-issue — unlabelled notes from the legacy ledger section "2026-09-26 — Answer-engine Gemini grounding (issue #929)":

Context: audit-followup P2 `apps/api/src/services/answer-engine/gemini.provider.ts:47` — the
adapter's only grounding tool shape (`googleSearchRetrieval`, from `@google/generative-ai@0.24.1`)
was live-measured against the production key and found to be REJECTED (HTTP 400) by every 2.x
model, so the "ChatGPT/Gemini cites your store" signal had never fired. Branch
`fix/answer-engine-free-grounding`.
