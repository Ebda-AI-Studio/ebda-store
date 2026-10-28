# SR-3

> Section: 2026-09-16

**Ruling SR-3 — the same defect class in `agent-store-resolver.ts` and
`sitemap.ts` is reported, not fixed.** Both still do `if (!res.ok) return null`
(or `break`), so during a 429 burst `/llms.txt` and `/.well-known/*` serve the
PLATFORM document instead of the merchant's, and the sitemap silently truncates.
Both are bot-facing, not shopper-facing, and today's approved scope is this fix
only. `ProductDetailBody.tsx:139` (F1) is excluded for the same reason.
Cost if wrong: crawlers see a platform document or a short sitemap during a
burst — an SEO cost with no customer impact, and one small PR to close later.
