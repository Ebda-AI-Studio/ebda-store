# BF-2c

> Section: Backlog batch followups (2026-10-01, branch `fix/backlog-followups`)

**Ruling BF-2c — the live-queue set-aside is guarded after the `rpop` (issue 2378).** The processor
had already `rpop`ped an unreadable entry when it called `parkCorrupt` unguarded, so a rejected
LPUSH/LTRIM/EXPIRE destroyed the entry with only a generic "Error processing queue" log. Both
queues now call `setAsideUnreadable` (`lib/dead-letter.ts`), the replayer's guard shape: park it;
on a rejected park put the raw entry back on the LIVE queue (LPUSH — the far end from the
consumer's RPOP, so a persistently failing park cannot wedge the queue head) for the next tick;
only if both writes fail is it lost, which raises a P1 (`email.queue.unreadable_lost` /
`sms.queue.unreadable_lost`) with its size and list only — the payload is never logged or alerted
(no PII). Residual: while Redis keeps rejecting the park but accepting the put-back, the same entry
cycles once per tick with an error log each time. Cost if wrong: a Redis write failure that
persists fills the error log with one line per tick until it clears — noise, not loss.
