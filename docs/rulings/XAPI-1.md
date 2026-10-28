# XAPI-1

> Section: Backlog batch x-api (2026-10-01, branch `fix/backlog-x-api`)

**Ruling XAPI-1 — an unrecognised boolean query value is a 400, not a silent `false` (issue 2319,
accepted residual).** `parseOptionalBooleanQuery` accepts only `true`/`false` on
`GET /public/products` (`featured`) and the admin product list/search (`featured`, `inStock`,
`onSale`, `isNew`); anything else (`''`, `1`, `0`, `yes`, `TRUE`, a repeated param) answers 400
`VALIDATION_ERROR`, where before PR 2315 it silently meant "no filter". Every in-repo caller was
checked and sends only the literal `true`/`false` (the audit's own enumeration: web `api.ts`,
`ProductsClient`, `HomePageBody`, `rls-payload-parity.mjs`; nothing in admin sends these params).
Not checked, because this lane may not read production logs: out-of-repo callers — the WhatsApp
bridge repo, merchant integrations, saved links carrying `?featured=1`. Coercing legacy values was
declined: `1` never meant "featured only" before (it meant no filter), so any coercion would change
an answer silently, which is the defect PR 2315 fixed. Cost if wrong: an out-of-repo caller sending
a legacy value gets a 400 on a listing that used to return 200; settle it by grepping 7 days of
API/Cloudflare logs for `featured=` values other than `true`/`false`.
