# NZ-PG-9

> Section: NEON-ZERO Postgres remnants (2026-11-05)

**Ruling NZ-PG-9 - `STORE_CREATE_ON_DO` stays `""` in `apps/api/wrangler.jsonc` (cutover step 7 sets it after the platform copies), and a Worker where every `platform_cutover.*` marker is set, Hyperdrive is absent and the var is unset reports it.** Setting it in the code deploy would let a store be created on the DO inside the copy window, and the copy step's "delete D1 rows Postgres lacks" could remove it. Instead `lib/store-create-config.ts` computes `on | pending-cutover | misconfigured`; `GET /health` carries `store_create` (never degrades the deploy probe, the var is set at a later step) and the `*/15` cron job `store-create-config` raises P1 `api.store_create_on_do_unset` (once per 6 hours per isolate). Documented in `docs/ENVIRONMENT.md`. Evidence: `tests/unit/store-create-config.test.ts`. Cost if wrong: between the last marker and step 7 every store creation fails and one P1 per isolate per 6 hours is sent.
