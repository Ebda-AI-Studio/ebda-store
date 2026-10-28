# LEGAL-5-M24

> Section: 2026-10-07 — Legal pages v1.0 (branch `docs/legal-pages`)

Ruling LEGAL-5-M24 — rollout order: deploy the API (`gh workflow run cf-api-deploy.yml`) immediately after the merge auto-deploys the admin. Between the two, the old API ignores `acceptedLegal` (its schema is not strict), so signups in that window get NO acceptance rows; after deploy, list them read-only (`users` created in the window with 0 `legal_acceptances` rows) and record the count in the PR. The reverse order is not used (a cached old admin tab would get 400 on signup). Cost if wrong: a handful of merchants with no recorded v1.0 acceptance (v1.0 is non-material; nothing asks them again).
