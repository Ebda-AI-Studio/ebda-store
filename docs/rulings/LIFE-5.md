# LIFE-5

> Section: Lifecycle emails and referral attribution (2026-10-22, branch `feat/lifecycle-emails`)

- Ruling LIFE-5 - the "made with Ebda" badge now links to `https://ebda.app/?utm_source=ebda_store_badge&utm_medium=referral&utm_campaign=powered_by&utm_content=<store host>`; the first-order email links with `utm_source=merchant_email`. The marketing site's existing first-touch capture (cookie, then `users.acquisition`) carries it to the signup, and the super-admin dashboard shows the two counts (`referrals` in `GET /admin/dashboard`). It counts only visitors who consented to tracking, so it is a floor. Cost if wrong: signups from visitors who declined tracking are invisible; the count under-reports, never over-reports.
