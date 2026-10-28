# PROVIDERS-KASHIER-VERIFIED

> Section: PROVIDERS-KASHIER-VERIFIED (2026-10-08)

Ruling PROVIDERS-KASHIER-VERIFIED — Kashier is marked `verified: true` (sandboxVerifiedAt 2026-10-08). Evidence: `scripts/provider-sandbox-check.mjs kashier` against Ebda's own Kashier TEST account (MID-51994-176): test connection, guest payment session, paid via Kashier's 3DS test card, partial (0.40) and full refund, and a REAL signed webhook delivery captured through a local tunnel that `verifyWebhook` accepted (a tampered amount was rejected). Accepted residual: Kashier's order search keeps reporting `completed` after a full refund, so refund state comes from the refund response and the webhook, never from `getStatus`. Cost if wrong: a merchant's refunded Kashier payment could show as paid if a refund response were lost and no webhook arrived — reconcile from the Kashier dashboard.
