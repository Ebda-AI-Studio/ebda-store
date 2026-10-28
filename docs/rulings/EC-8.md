# EC-8

> Section: 2026-09-25

**Ruling EC-8 — the test send and the AI draft run inline in the request.** _(Test-send half
SUPERSEDED by Ruling R3-2, #1954 — the AI-draft half stands.)_ Both are one external
call made by a merchant who is waiting for the result (one Resend send to their own address; one
Gemini call, quota-capped, the same shape as every other `/stores/:id/ai/*` suggestion route).
Neither fans out. Cost if wrong: a slow Gemini response holds one tenant transaction open for its
duration (bounded by the 30s transaction timeout).
