# CLOSURE-S9

> Section: Admin audit closure 2026-11-09, phase 2 (branch `fix/admin-audit-closure`)

Ruling CLOSURE-S9 - BE:S-9, `DELETE /stores/:id/faqs/:faqId` and `/howtos/:howtoId` stay ungated by `requireFeature('seo')`. The route comments already say deletes stay open so a downgraded store can clean up what it can no longer edit; the write routes (POST/PUT, seo PUT) are gated. `slug-redirects.routes.ts` has only GET and DELETE (no POST/PUT exist; redirects are recorded server-side by `recordSlugRedirect`), and its DELETE is already gated. Cost if wrong: a downgraded store can still delete (never add or edit) its own FAQ/how-to rows.
