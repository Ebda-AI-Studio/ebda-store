# EBDA-FUNNEL-10

> Section: 2026-10-07 — Signup funnel: plan choice, card on file or InstaPay, 14-day Growth trial (branch `feat/signup-funnel`, stacks on #10)

Ruling EBDA-FUNNEL-10 — Billing suspension sets `stores.status = suspended` with `billing_suspended_reason` (`unpaid` | `over_store_limit`), so the storefront shows the existing neutral maintenance page ("we'll be back soon", no billing details). Only a billing reason is lifted automatically. A super-admin suspension (reason NULL) is never touched (M4), and a never-live store is not suspended (M5). An `unpaid` store's admin stays fully usable so the merchant can pay. An `over_store_limit` store is read-only for the merchant (`requireStoreAccess` refuses non-billing writes with a 402 upsell); super-admins are not bound. Cost if wrong: the maintenance copy says "maintenance" rather than "temporarily unavailable" (both neutral).
