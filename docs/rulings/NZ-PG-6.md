# NZ-PG-6

> Section: NEON-ZERO Postgres remnants (2026-11-05)

**Ruling NZ-PG-6 - when a billing `--commit` aborts and is not re-run, the webhooks stored during its freeze are never applied, so the `billing-deferred-webhooks` cron raises a P1.** `processDeferredBillingWebhooks` returns 0 until `platform_cutover.billing` exists; the gateway was answered 200 and will not retry. `alertOrphanedDeferredWebhooks` (`services/billing/subscription-billing.service.ts`) counts deferred rows older than 30 minutes in D1 and sends `billing.deferred_webhooks_orphaned` (P1, at most once per 6 hours per isolate; a D1 outage is logged, never thrown). Runbook line: `docs/runbooks/platform-family-cutover.md`. Evidence: `tests/unit/postgres-gone-definers.test.ts`. Cost if wrong: a duplicate P1 per isolate every 6 hours until the cutover is re-run or the rows are applied by hand.
