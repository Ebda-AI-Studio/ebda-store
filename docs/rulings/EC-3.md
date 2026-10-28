# EC-3

> Section: 2026-09-25

**Ruling EC-3 — on an enqueue failure the campaign returns to `draft`, not `failed`.** The spec says
"if the Inngest send throws, mark the campaign failed". The send route answers 503, and a 5xx rolls
back the whole request transaction (`middleware/request-transaction.ts`), so the `draft → scheduled`
flip is undone and a `failed` write would be undone with it. The outcome the rule exists for — no
campaign left `scheduled` with no job behind it — holds, and the merchant can simply press send
again. The job-side failure path (`onFailure`) does mark the campaign and every still-queued
recipient `failed`. Cost if wrong: an enqueue failure leaves no persistent trace on the campaign
itself — it is in the API error log and the merchant saw the 503.
