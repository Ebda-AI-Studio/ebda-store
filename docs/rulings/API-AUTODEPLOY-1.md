# API-AUTODEPLOY-1

> Section: Lifecycle emails and referral attribution (2026-10-22, branch `feat/lifecycle-emails`)

Ruling API-AUTODEPLOY-1 - the API Worker deploys automatically on a push to main that changes apps/api/**, packages/**, package(-lock).json, the deploy config script or the workflow itself (Ahmad, 2026-10-25). Same gates as a manual run (workerd smoke, migrate, deploy, /health commit verify with auto-rollback, Inngest sync); concurrency group `ebda-api-production` queues deploys and never cancels one. Evidence: a push never redeployed the API, so main and production drifted (CLAUDE.md "Known gap"). Cost if wrong: a bad merge reaches production within minutes; the smoke and auto-rollback bound it, migrations stay expand-then-contract.
