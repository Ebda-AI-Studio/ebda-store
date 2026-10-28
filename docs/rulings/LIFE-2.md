# LIFE-2

> Section: Lifecycle emails and referral attribution (2026-10-22, branch `feat/lifecycle-emails`)

- Ruling LIFE-2 - the setup nudges and the trial recap are ONE sleeping Inngest run per self-serve store (`lifecycle-emails`, started by `store/self-serve-provisioned`, which `provisionStore` emits only when `growthTrial` is set), not a cron. `step.sleepUntil` is durable across deploys and a store costs about 12 executions once, where a daily scan of every store would add 60 to 360 a month and breach INNGEST-BUDGET-1. The first-order referral ask rides `order/created` (concurrency 2). Cost if wrong: a store provisioned before this deploys is never enrolled (acceptable: there are no live merchants yet); an Inngest outage during the sleeping window delays a nudge, never sends it twice.
