# TYPO-WRITER-1

> Section: 2026-11-11 plans-vs-main audit, M-153

Ruling TYPO-WRITER-1 - `stores.typography` has ONE writer: builder publish/rollback (`page-builder.service.ts`, same transaction as the revision, with the font-URL guard and R2 orphan cleanup). `PUT /stores/:id/typography` is removed; `GET` stays (the builder editor reads live zones through it). Evidence: no admin or web caller of the PUT remains (the standalone /typography page redirects to /builder); guard test `typography-single-writer.test.ts` fails if a write verb returns to the route. Cost if wrong: a script or old client that still PUTs gets 404 and must publish through the builder instead; no data is lost, the change is one route re-added.
