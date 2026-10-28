# EC-4

> Section: 2026-09-25

**Ruling EC-4 — the request sends the Inngest event inside its own transaction, and the job treats
`draft` as "not committed yet" and retries.** `deferAfterTenantCommit` would remove the race but
turns an enqueue failure into a post-response event with nothing to retry it, i.e. a campaign
stuck `scheduled`. `scheduledAt` travels in the event as a per-request nonce: the claim and
`onFailure` only act when `campaigns.scheduled_at` still equals it, so an event from a rolled-back
or superseded request can neither send nor fail a newer one. Cost if wrong: a send whose COMMIT
fails after the event went out burns up to 5 job attempts on a campaign that stays `draft`.
