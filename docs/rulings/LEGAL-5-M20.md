# LEGAL-5-M20

> Section: 2026-10-07 — Legal pages v1.0 (branch `docs/legal-pages`)

Ruling LEGAL-5-M20 — the signup account INSERT stays before the acceptance transaction (already LEGAL-5(e), pre-existing `ebda_admin_user_ensure` pattern). Cost if wrong: an account with no signup acceptance rows after a crash between the two writes.
