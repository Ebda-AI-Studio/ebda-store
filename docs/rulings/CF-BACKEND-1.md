# Ruling CF-BACKEND-1 - the backend of a store is server-side state only

**Date:** 2026-10-30
**Decision:** `backendFor(storeId)` reads the D1 `stores.storage_backend` column and nothing from the request. The Phase 0 `x-ebda-backend: do` header is removed from `lib/store-backend.ts`, the repo factory, the job scope and the three spike branches in `public.routes.ts`, and is stripped at the Worker edge (`worker.ts`) and in Express (`app.ts`). With D1 unbound (Node, tests, local) the `STORE_DO_ENABLED_IDS` list decides outside production; in production a listed store with no D1 is a 503. An unreadable or malformed flag is a 503 (`STORE_BACKEND_UNAVAILABLE`), never a default to pg. A store without a directory row is not flagged.
**Evidence:** `resolve()` used `backendFor(storeId, req)`, so any visitor could put a listed store's money, stock and writes on the Durable Object while its real backend was Postgres (split-brain money state). `tests/unit/store-backend-flag.test.ts`.
**Cost if wrong:** a store flagged `do` in D1 but unreadable returns 503 until D1 recovers, instead of serving stale Postgres data.
