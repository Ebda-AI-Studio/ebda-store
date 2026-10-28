# EC-2

> Section: 2026-09-25

**Ruling EC-2 — "confirmed subscriber" means `is_active = true AND unsubscribed_at IS NULL`; there is
no double opt-in.** `newsletter_subscribers` has no confirmation field and the storefront signup
(`public.routes.ts /newsletter/subscribe`) activates on submit. Adding double opt-in would change a
live signup flow on 3 stores. Cost if wrong: an address someone else typed into a store's footer
can receive that store's campaigns until it clicks unsubscribe — mitigated by the one-click
unsubscribe and the per-store 24h cap.
