# LOOKS-4

> Section: 2026-10-14 — Security batch (branch `fix/security-batch-2026-10-14`, audit: `docs/security/audit-2026-10-14.md`)

Ruling LOOKS-4 — demo preview is a per-store flag `stores.is_demo` (API-gated) plus `?look=<id>` honoured only on demo stores, and any order on a demo store is refused server-side (`403 DEMO_STORE` in `assertOrderAllowed`). Evidence: MKT-3; `tests/integration/demo-store.test.ts` proves no order row and no stock movement. Cost if wrong: a cached demo page leaks into a real store, prevented by `no-store` on any response that carried `?look=` (LOOKS-12).
