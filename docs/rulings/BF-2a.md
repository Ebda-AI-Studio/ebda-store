# BF-2a

> Section: Backlog batch followups (2026-10-01, branch `fix/backlog-followups`)

**Ruling BF-2a — replay never destroys a popped entry, and SMS gets the email queue's page
(issues 2361, 2363; supersedes BF-2's "no SMS page").** One replay loop,
`replayDeadLetters` in `lib/dead-letter.ts`, now serves both queues: every Redis write after the
`rpop` is guarded, a failed re-queue or set-aside puts the raw entry back on the dead-letter list
(`kept`, reported by the route and the page) and the loop continues; a failed `rpop` removed
nothing and ends the run. Only when the re-queue AND the put-back are both rejected is an entry
lost — logged by id (never payload) with a P1 (`*.queue.replay_lost`). `sms:failed` is live data
(the transactional SMS path enqueues for any store with an SMS provider configured), so it gets
the email twin's surface: `GET /admin/sms-queue/failed` (number masked, text never returned),
`POST …/failed/retry` and `POST …/corrupt/discard`, super-admin only and audited
(`sms_queue.retry_failed`, `sms_queue.discard_corrupt`), and a `/sms-queue` page cross-linked with
`/email-queue`. Both list routes now report stats as unknown (`null`) when Redis is down instead of
zeros. Cost if wrong: a Redis outage that rejects two writes in a row loses the entries being
replayed at that moment (alerted, by id).
