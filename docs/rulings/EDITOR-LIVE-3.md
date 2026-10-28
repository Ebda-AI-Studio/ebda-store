# EDITOR-LIVE-3

> Section: 2026-10-07 — Visual builder canvas never became interactive on the hosted preview (branch `fix/editor-live-preview`)

Ruling EDITOR-LIVE-3 — the real-stack editor E2E (`playwright.editor-live.config.ts`) is local-only, not a CI job: it needs a Postgres, `wrangler dev` and two Next production builds (~10 min). The fast contract suite (`playwright.builder.config.ts`) stays the CI gate. Cost if wrong: an integration regression between admin, storefront and API reaches a deploy before someone runs the local suite.
