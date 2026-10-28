# LEGAL-5-M6

> Section: 2026-10-07 — Legal pages v1.0 (branch `docs/legal-pages`)

Ruling LEGAL-5-M6 — documented, not coded: pending = the current version only; publishing a follow-up version during a notice window is forbidden by the runbook (§1 step 3) instead of computing "newest sent material version after the user's last acceptance". Evidence: `computePendingNotices` / `isNoticeable` in `packages/shared/src/legal`; runbook step added 2026-10-15. Cost if wrong: an operator publishes a typo fix mid-window and merchants who had not pressed "Got it" stop seeing the material notice (they still got the email).
