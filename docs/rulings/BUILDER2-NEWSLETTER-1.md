# BUILDER2-NEWSLETTER-1

> Section: 2026-10-07 — Visual builder Phase 2: the editor (branch `feat/builder-phase2`, BUILDER2-\*)

Ruling BUILDER2-NEWSLETTER-1 — FINDING (pre-existing, not fixed here): the legacy `POST /stores/:id/newsletter/broadcast` sends to every active subscriber with NO unsubscribe link (campaign D2 emails carry a signed one-click link; broadcasts reuse one HTML for all recipients and have no recipient rows to sign). The newsletter section therefore promises only "you agree to receive marketing emails from this store" + the privacy link, not a one-click unsubscribe. Fix belongs to the campaigns area: retire `/newsletter/broadcast` in favour of campaigns, or add a per-subscriber signed token. Cost if wrong: a subscriber who joins via the section and later receives a broadcast cannot unsubscribe from that email (consent/withdrawal gap) — flagged for Ahmad, not deferred silently.
