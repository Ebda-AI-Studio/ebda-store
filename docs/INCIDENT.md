# Incident Response — FWB

Companion to `docs/ROLLBACK.md`. Rollback covers HOW to recover.
This doc covers HOW to know there's an incident AND HOW to triage it.

## Severity matrix

| Severity | Definition                                                    | Examples                                                                                                    | Response time           |
| -------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------- |
| **P0**   | Site fully down OR data integrity at risk OR payments failing | API health check failing, Neon unreachable, all checkouts 500ing, customer data leak                        | Investigate immediately |
| **P1**   | Major feature broken, workaround exists                       | Checkout works but cart sync broken, admin can't log in but storefront works, AI sweep stuck queued for >2h | Investigate within 1h   |
| **P2**   | Minor feature degraded, low-impact                            | Slow image loads, abandoned-cart emails delayed, single store's pixel firing wrong event                    | Same-day                |
| **P3**   | Cosmetic / non-functional bug                                 | Typo, off-by-one date format, AR translation slightly wrong                                                 | Next-sprint backlog     |

## Detection sources (where alerts come from)

In rough order of how an incident usually surfaces:

1. **UptimeRobot / BetterUptime monitor** — `/health` endpoint check every 5 min → Telegram alert on 2 consecutive failures. **Configure this first; without it everything below is reactive.**
2. **Sentry** — new error cluster or rate spike on existing cluster. Alert rules: >10 new errors/hr OR any new issue type. Telegram integration.
3. **Merchant report** — WhatsApp / email from Ahmad's contacts. Treat as P1 minimum until ruled out — merchants don't ping for cosmetic issues.
4. **`cf-deploy.yml` workflow failure (GitHub Actions)** — a red `cf-deploy` run on `main` means Cloudflare Workers (web/admin/orders) are still serving the OLD build even though the merge shows green. P1; rerun with `gh run rerun <id> --failed` after fixing the cause — or, if a newer run on `main` has since gone green, do NOT rerun the old one (its deploy jobs would ship the older commit); the next run already diffs from the last success and picks the failed changes up, or `workflow_dispatch` redeploys `main`.
5. **Railway deployment failure** — same, P0 if production health check failed.
6. **Customer-facing site error message** — explicit user complaint, often surfaces P1-P2 issues that don't trigger alerts.

## P0 Triage Checklist (run in order, stop when you find the root cause)

**1. Is the API up?**

```bash
curl -sS -m 10 -o /dev/null -w "HTTP %{http_code} | %{time_total}s\n" \
  https://api.force-ai.co/health
```

- HTTP 200 in <1s → API is up; problem is downstream
- HTTP 5xx OR timeout → API is down; check Railway dashboard
- HTTP 401/403 → auth middleware error; check Sentry

**2. Is the database reachable?**

- Railway dashboard → API service → Logs → search "prisma:error" → "Connection refused" / "Closed"
- Neon dashboard → check compute status + connection pool depth
- If Neon is degraded → check Neon status page (status.neon.tech)

**3. Is Inngest processing jobs?**

```bash
cd ~/Desktop/projects/force-website-builder/apps/api
railway logs --lines 100 | grep -i inngest
```

- Stuck "queued" jobs older than 5 min → Inngest sync broken (see `feedback-inngest-deploy-sync-trap.md`)
- Recovery: `curl -X PUT https://api.force-ai.co/api/v1/inngest` to force re-sync

**4. Is Sentry showing a new error cluster?**

- sentry.io → ForceAI-KW project → Issues sorted by Last Seen
- New cluster in last 30 min = likely the root cause
- Stack trace's top frame is your starting point

**5. Did anything deploy in the last hour?**

```bash
cd ~/Desktop/projects/force-website-builder
git log --since="1 hour ago" --pretty=oneline
```

- If yes → strong signal that the deploy regressed something. Read `docs/ROLLBACK.md` for paths.

**6. Are payments failing specifically?**

- Filter Sentry by tag `payment.provider` (tap / myfatoorah / hesabe / upayments)
- Check the provider's own status page:
  - MyFatoorah: status from merchant portal
  - Tap: status.tap.company
- If provider is up but FWB shows errors → check the recent webhook signatures (per-store credential rotation can break HMAC)

## Recovery actions

Once you've identified the failure mode:

| Symptom                                  | Fix                                                                                                                                                                 | Reference                                     |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Bad deploy, no migrations                | `git revert HEAD && git push`                                                                                                                                       | `scripts/rollback.sh`                         |
| Bad deploy WITH a migration              | Neon branch restore → `prod-<previous-sha>`                                                                                                                         | `docs/ROLLBACK.md`                            |
| Worker (web/admin/orders) down           | `wrangler rollback` to the previous version, or rerun the LATEST green `cf-deploy` run (re-running an older run is a deliberate no-op — its commit is already live) | `docs/ROLLBACK.md`                            |
| Railway service stuck                    | Railway dashboard → API service → Deployments → previous → "Redeploy"                                                                                               | `docs/ROLLBACK.md`                            |
| Inngest functions not firing             | `curl -X PUT $API_URL/api/v1/inngest` to force manifest re-sync                                                                                                     | `feedback-inngest-deploy-sync-trap.md`        |
| Rate-limit false positives               | Bump `publicLimiter` cap temporarily OR add path-specific skip                                                                                                      | `feedback-status-polling-rate-limiter.md`     |
| Webhook signatures failing for one store | Re-paste webhook secret from provider portal → admin `/stores/[id]/seo` payment settings                                                                            | `feedback-payment-listing-bugs-2026-05-12.md` |

## Post-incident

After every P0 or P1 resolved:

1. Write a one-paragraph summary in `docs/incidents/<date>-<short-title>.md`:
   - What happened
   - What customer/merchant impact
   - Root cause
   - How resolved
   - Prevention: add to memory? add to test suite? add new alert?

2. If a new failure class was discovered → update memory at `~/.claude/projects/-Users-ahmadsharaf/memory/` OR FWB project memory.

3. If a code change is needed → file under `docs/superpowers/plans/` with the canonical date-prefix slug.

## Solo-developer reality check

FWB is operated by one person. The P0 response time of "investigate immediately" depends on Ahmad being awake or near a phone. The minimum bar:

- **UptimeRobot Telegram alert** is the only reliable wake-up signal at 3am. Without it, downtime can run for hours undetected.
- **Sentry Telegram alert** catches application errors when uptime is fine but functionality is degrading.
- These two together cover the realistic P0 surface for a solo-operator project.

Until one of those channels exists, this runbook is aspirational — you can't triage what you don't know about.
