# B2B-I5b

> Section: B2B wholesale pricing (feat/b2b-wholesale, 2026-10-21)

Ruling B2B-I5b - the admin badge for pending wholesale applications ships with the Wholesale applications tab (Task 7), on that tab and on the customers tab, fed by `GET /stores/:id/wholesale-applications/summary`, the `wholesale.application.received` socket notification and a 5-minute refresh; the 48h nudge is a daily Inngest job that nudges an application only on the run where its age is in [48h, 72h), so no flag column is needed. Cost if wrong: if the job is delayed a day an application can be nudged once late; if it is skipped for three days one is never nudged.
