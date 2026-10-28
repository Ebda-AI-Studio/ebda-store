# EBDA-FUNNEL-7

> Section: 2026-10-07 — Signup funnel: plan choice, card on file or InstaPay, 14-day Growth trial (branch `feat/signup-funnel`, stacks on #10)

Ruling EBDA-FUNNEL-7 — `POST /stores` gap closed: a merchant-created store (not the platform operator) starts `inactive`. The first store goes on the Growth trial (it no longer starts Basic-active for free); an additional store starts on Business tier, mirroring onboarding. Evidence: integration "POST /stores gap". Cost if wrong: an API client that expected an instantly-live store now has to go through go-live.
