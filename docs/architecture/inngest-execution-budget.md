> **Historical (Ruling G5-3, 2026-10-25).** Inngest was removed; background jobs run on Cloudflare Workflows and Queues, billed with Workers. The execution budget below no longer applies and its guard test is deleted. Kept for the reasoning behind the hourly cadences.

# Inngest execution budget

Ruling INNGEST-BUDGET-1 (docs/RULINGS.md). Ebda is on the Inngest **Hobby** plan: 50,000 executions a month.

## What an execution is

Inngest prices "a single durable function run or step execution" (https://www.inngest.com/pricing, plan table), and its calculator states **Executions = runs x (steps + 1)**. So a cron tick that opens one `step.run` costs 2, and a tick that opens three costs 4, even when it finds nothing to do. A function with no `step.run` costs 1 per tick.

## Where the overrun came from (measured 2026-10-22)

27,313 executions used by Oct 22, about 38k for the month. Nine functions fired every 15 minutes (2,880 runs each, 25,920 a month), plus one every 30 minutes and two hourly. Ebda has no real orders yet, so none of that work was doing anything.

## Rules

1. Pre-launch, sweeps and watches run **hourly** (minute 7, off the :00 pile-up). Exception: payment-webhook-stuck-sweep, every 30 minutes, because a shopper who has paid sits on a pending order until it runs.
2. An idle tick costs **one** execution. A sweep reads its candidates un-stepped (`stepRunUnlessEmpty`, `apps/api/src/lib/inngest/empty-exit.ts`) and returns when there are none; with candidates the read is memoised through `step.run` as before. A sweep that is one idempotent unit has no step at all.
3. All crons together stay under **12,000 executions per 30-day month**, enforced by `tests/unit/inngest-cron-budget.test.ts`. That leaves about 38,000 for event-driven work and retries.
4. Merging the hourly sweeps into one function was considered and rejected: steps are billed too, so one function with N sweep steps costs N + 1 per tick against N with empty-exit, and it would lose per-function retries, concurrency and function-id based failure alerts.

## Current crons (executions per month, conservative pricing)

| Cron                                                                                                                                                                                                                                                            | Schedule           | Idle cost   |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ----------- |
| payment-webhook-stuck-sweep                                                                                                                                                                                                                                     | every 30 min       | 1           |
| agent-write-denied-watch, domain-claim-sweep, gmail-alert-poller (not served on Workers, still counted), instapay-expiry, order-created-stuck-sweep, order-status-fanout-stuck-sweep, payment-abandonment-sweep, queue-depth-watch, refund-reversal-stuck-sweep | hourly             | 1           |
| heartbeat, payment-reconcile-sweep                                                                                                                                                                                                                              | hourly (unchanged) | 1           |
| the other 24 daily, weekly, monthly and 4/6-hourly crons                                                                                                                                                                                                        | unchanged          | priced at 2 |

Total 11,036 (10,198 runs). Was 29,638 runs, 58,556 priced the same way.

## Register line

**Revisit all of these intervals at launch, when real orders exist** (`payment-webhook-stuck-sweep` back to 15 min or less if the first weeks show lost webhooks; the order, refund and status-fanout sweeps if a merchant notices a late confirmation). Re-measure usage in the Inngest dashboard first, then edit the budget and the ruling together.
