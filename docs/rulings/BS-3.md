# BS-3

> Section: 2026-10-01 — backlog batch b-services (branch `fix/backlog-b-services`)

**Ruling BS-3 — issue 2142 amends R2-8: the refund fanout's in-band gate still covers only a render
or enqueue failure; a delivery failure is surfaced by the queue itself.** `enqueue` resolves once
the email is on the Redis list, so no `{ queue: true }` caller can see a later Resend failure. The
queue now raises a P1 alert (`email.queue.permanent_failure`, no recipient address in it) when an
email exhausts its attempts or cannot be re-queued, and the dead-letter list `email:failed` is shown
and replayable at the super-admin page `/email-queue` (R2-8's "no UI" residual is closed). With
Redis down, the inline send now rejects to its caller, so the #1935 gate and Inngest step retries
see that failure. The `refund_notified` claim is NOT released on a delivery failure — replaying the
dead-lettered email from `/email-queue` is the recovery, and it cannot double-notify. Cost if wrong:
the customer is told late — after the P1 alert and an operator's replay. **Amended (issue 2292,
backlog batch x-api):** an email whose re-queue PUSH is rejected while Redis is still reachable is
now parked in `email:failed` before the P1 (it used to page the operator to a page that could not
list it), and the alert says so when it truly could not be saved (Redis gone). The page's "Retry
all" parses each entry on its own: an unreadable entry is moved to `email:failed:corrupt` and
counted as skipped (shown as a partial result, EN + AR) instead of being destroyed by a throw that
also stranded every entry behind it. Cost if wrong: an entry in `email:failed:corrupt` is never
replayed automatically — it has no UI and needs `railway connect Redis` to inspect. Setting entries aside raises a P1 (`email.queue.corrupt_entries`) naming the count and the list (PR
2335 audit), so it is never silent.
