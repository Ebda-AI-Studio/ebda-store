# INFRA-PREVIEW-0

> Section: Lifecycle emails and referral attribution (2026-10-22, branch `feat/lifecycle-emails`)

Ruling INFRA-PREVIEW-0 (2026-10-24) — the Cloudflare PREVIEW environment is removed: workers ebda-{admin,api,marketing,web}-preview, queues ebda-preview-{email,sms} (+DLQs), R2 ebda-preview-{isr-cache,media}, KV ebda-preview-cache, Hyperdrive ebda-preview and domains admin-/api-/dahab-preview + preview.ebda.app are deleted; `scripts/preview/*`, the three `preview-worker*` entries, `tests/unit/preview-config-no-ai.test.ts` and the ENVIRONMENT.md preview section are removed so nothing can redeploy it. The builder canvas preview (`apps/web/src/builder/preview`, look-switch tokens) is a feature, not this environment, and stays. Residual: `dahab-preview` remains the seed slug/local-routed origin of the live-editor e2e and `scripts/dahab-demo` defaults. Cost if wrong: a preview stack must be rebuilt from git history (scripts/preview at 45babd67a).
