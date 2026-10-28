# LEGAL-2

> Section: 2026-10-07 — Legal pages v1.0 (branch `docs/legal-pages`)

Ruling LEGAL-2 — TODO, no automatic job exists: a suspended or unpaid store is NOT deleted by any cron (billing-renewal only suspends after `INSTAPAY_GRACE_DAYS` = 3). The Merchant Agreement and Privacy Policy therefore promise only "kept until the merchant asks for deletion or the account is closed, then deleted within 90 days". That 90-day deletion is a manual/ops process today; build a job or keep it manual. Cost if wrong: a deletion request past 90 days is a broken promise in the published text.
