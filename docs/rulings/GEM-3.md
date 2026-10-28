# GEM-3

> Section: 2026-09-26 — Answer-engine Gemini grounding (issue #929)

**Ruling GEM-3 — a persisted `groundingUnavailableReason` column, not a log-only signal.** The
brief's fallback contract ("record the answer as not-grounded with a reason so the dashboard shows
'search grounding unavailable'") needs a signal the merchant-facing dashboard can read, and
`AnswerEngineCheck` had no column carrying the in-memory `EngineAnswer.grounded` flag at all (see
the pre-existing `GROUNDED-CAVEAT PROXY` note in `dashboard.service.ts` — the existing
`groundedCaveat` is already a proxy off `citedUrls` emptiness because of this gap). Reusing that
proxy for the new "grounding could not run" case would conflate it with "grounding ran fine, cited
nothing" — a merchant told "no live citations found" when the real cause is a rationed model reads
as their store's real citation performance. Added one nullable, additive `TEXT` column
(`grounding_unavailable_reason`) instead — no RLS policy change needed, the tenant policy on
`answer_engine_checks` is table-level. Cost if wrong: a schema change for what could have been a
log-line; the residual is a single small migration against an append-only table, reversible by
dropping the column.
Context: branch `fix/p2-r3-residuals` — four items previously parked as needs-owner or accepted
residuals, decided by the owner rule "fix everything" (Ahmad, 2026-09-25): #1955, #1608, #1766,
#1954.
