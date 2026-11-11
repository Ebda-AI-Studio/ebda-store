# POSTHOG-EU-1

> Section: Audit S4-14 (2026-11-12)

**Ruling POSTHOG-EU-1 - the admin and storefront CSPs allow PostHog EU hosts only; the US hosts are removed.** Measured 2026-11-12: the `production` environment variable `NEXT_PUBLIC_POSTHOG_HOST` is `https://eu.i.posthog.com` (set 2026-10-07), the admin provider defaults to the same host, and the privacy text says EU. The live store CSP still listed `us.i.posthog.com` and `us-assets.i.posthog.com` in script-src and connect-src, an allowance for a region the product does not use. Guard: `tests/unit/csp-posthog-eu-only.test.ts`. Cost if wrong: if a deploy ever sets a US PostHog host, analytics calls are blocked by the browser until the host is added back here.
