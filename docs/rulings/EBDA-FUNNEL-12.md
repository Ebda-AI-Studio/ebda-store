# EBDA-FUNNEL-12

> Section: 2026-10-07 — Signup funnel: plan choice, card on file or InstaPay, 14-day Growth trial (branch `feat/signup-funnel`, stacks on #10)

Ruling EBDA-FUNNEL-12 — Reminders at 7, 3 and 1 days before the trial or period end and on the due day: email + bell. The in-admin banner is derived from `billing.dueSoon`. WhatsApp is a wa.me link only (`EBDA_SUPPORT_WHATSAPP`), with no API. Idempotent through `billing_reminders` (UNIQUE subscription + due date + kind). Only the most specific offset fires, so a missed day never replays the older reminders. Cost if wrong: a job down for the whole 7→3 window skips the d7 mail (the d3 still goes).

See also BILL-NOTICE-1: grace-period notices reuse `billing_reminders` with kinds `grace_start`, `grace_d1` and `suspended`.
