# WH-1

> Section: 2026-10-15 — Phase B1 Qamar (B1-\*)

Ruling WH-1 (2026-10-21, merchant outgoing webhooks) — merchant OUTGOING webhooks are gated to Growth + Business by `planIncludesWebhooks` (`@ebda/shared`, `schemas/webhook.ts`; enforced by `requireWebhooksPlan` in `routes/merchant-webhooks.routes.ts`, 402 `PLAN_LIMIT_REACHED` with an upgrade target, super_admin bypasses), NOT by `apiAccess`. This is the "merchant webhook feature added later" that R-EBDA-PRICING-4 anticipated; it deliberately does not follow `apiAccess` (Business only) because the brief set Growth + Business, matching the merchant MCP (R-EBDA-PRICING-5). Evidence: `tests/unit/merchant-webhooks-routes.test.ts` (free, basic and no-entitlement 402; growth, business 200). Cost if wrong: Growth merchants get a feature the pricing page sells only on Business, or the reverse; one constant (`WEBHOOK_PLAN_CODES`) to change.
