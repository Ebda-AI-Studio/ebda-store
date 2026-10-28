# ID-7

> Section: Lifecycle emails and referral attribution (2026-10-22, branch `feat/lifecycle-emails`)

Ruling ID-7 (2026-10-24) - the identity login throttle (5 per email, 30 per IP per 15 minutes) lives in D1, not a Durable Object. Cost if wrong: contention under attack volume; a Durable Object is the drop-in upgrade.
