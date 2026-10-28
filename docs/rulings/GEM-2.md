# GEM-2

> Section: 2026-09-26 — Answer-engine Gemini grounding (issue #929)

**Ruling GEM-2 — default model is `gemini-2.5-flash-lite` (free), not a `-latest` alias.** Live
probes against the production key (2026-09-26): `gemini-2.5-flash-lite` + `google_search` → HTTP
200, `groundingChunks` populated, free. `gemini-flash-lite-latest` / `gemini-flash-latest` /
`gemini-3.5-flash-lite` + the same tool → HTTP 429 ("exceeded your current quota") — grounding is
paid-only on those aliases. `gemini-2.5-flash` → HTTP 404 (retired for new users). Per owner
decision (Ahmad, free option), the default points at the verified-free model; a merchant/operator
who wants a paid, higher-quality model can still override via `ANSWER_ENGINE_GEMINI_MODEL`. Cost if
wrong: if `gemini-2.5-flash-lite` is later retired or rationed the same way, every scan silently
falls back to ungrounded (by design — see GEM-3) until an operator notices the dashboard's new
"grounding unavailable" caveat and re-probes for a new free model.
