# EBDA-DEPLOY-3

> Section: 2026-10-07 — Legal pages v1.0 (branch `docs/legal-pages`)

Ruling EBDA-DEPLOY-3 — PostHog EU hosts added to the admin, web and orders CSPs. Evidence: the `production` repo var is `NEXT_PUBLIC_POSTHOG_HOST=https://eu.i.posthog.com` while admin/web CSP allowed only `us.i.posthog.com` and orders allowed no PostHog host, so every analytics call would have been blocked by the browser. Cost if wrong: none functional — two extra allowed origins on each CSP.
