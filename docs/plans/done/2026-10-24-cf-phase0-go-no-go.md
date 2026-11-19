# Phase 0 go/no-go: Ebda Store on Cloudflare only (Ruling INFRA-CF-1)

Date 2026-10-24. Plan: `docs/plans/done/2026-10-28-store-on-cloudflare.md`. Evidence: `spikes/store-do/` (README, `orm/README.md`, `results/`). Labels: **measured** = a number from a run in this session; **inferred** = reasoned from docs or code; **guess** = assumption.

## Verdict: GO, with three conditions

Gates 1 to 5 of the plan are met or met with a stated caveat (table below). The architecture works on the production Worker with the real Cloudflare runtime, behind a per-store flag, with no new Cloudflare resources (Rulings INFRA-PREVIEW-1/-0 honoured).

| #   | Gate                                                                         | Result                                                    | Evidence                                                                                                                                                                                                                                                       |
| --- | ---------------------------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | ORM decision recorded                                                        | **PASS** Drizzle on DO SQLite (Ruling INFRA-CF-2)         | Prisma 6.19.3 has no DO adapter, its D1 adapter drops transactions (`d1-worker.ts:195`); bundle 798 vs 34 KiB gzip; local workerd p50 4.4/6.0 vs 2.8/3.0 ms (list/cart-add) (measured)                                                                         |
| 2   | 5-table StoreDO serves product list, cart add, order create through the flag | **PASS**                                                  | `scripts/parity.mjs` against production: 7/7 checks (products equal on id/name/slug/price/status for 19 of 19 rows; cart 200 both paths; order created 201, total = qty x price = 260000); `x-store-backend: do` header present only with `x-ebda-backend: do` |
| 3   | Warm p95 of the DO path <= today's                                           | **PASS for list and cart add; order create NOT gateable** | table below                                                                                                                                                                                                                                                    |
| 4   | Cold start and cost per 1M requests                                          | **PASS (costed), cold INCONCLUSIVE**                      | cost section below                                                                                                                                                                                                                                             |
| 5   | Backup restores to identical row counts and checksums                        | **PASS live**                                             | `scripts/restore-drill.mjs` on production: 7 of 7 tables equal rows and sha256, independent R2 read of the manifest confirmed (measured)                                                                                                                       |

### Latency (production, from a Gulf client, storedemo-souq, 200 requests, concurrency 4, first 10 discarded; measured)

| Endpoint                | Postgres path p50 / p95 / p99 ms                                              | DO path p50 / p95 / p99 ms                                                                            | p95 gate                 |
| ----------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------ |
| GET products?limit=24   | 436 / 547 / 2294                                                              | **241 / 319 / 380**                                                                                   | PASS                     |
| POST cart/items (guest) | 5337 / 6795 / 11038                                                           | **702 / 1781 / 2168**                                                                                 | PASS (about 7.6x at p50) |
| POST orders (COD)       | not measured live (demo stores refuse orders, LOOKS-4; money paths untouched) | 614 / 1325 / 1325 (n=15, tails INCONCLUSIVE: 25 of 50 rejected by the IP write limiter or demo stock) | not gateable             |

Caveats that matter: (a) both paths still pay the same Postgres hop to resolve the host to a store id and the request transaction (`publicStoreContext`), so the DO numbers are the floor of today's pipeline, not of the target; the 5.3 s cart add is serial Worker to Frankfurt Neon hops, which a D1 directory removes. (b) Network floor from this client is about 300 ms per fresh connection. (c) The guest cart limiter and the 200 writes per 15 min IP cap truncated two series; both are stated, not hidden. (d) Cold: a first request after 7 minutes idle was 443 ms on the Postgres path (the isolate was probably warm); the DO cold start was NOT measured. INCONCLUSIVE.

### Cost (measured inputs from 436 DO requests on the demo store; prices fetched 2026-10-24 from the Cloudflare DO pricing page, last updated 18 Oct 2026)

Measured from Cloudflare analytics for the StoreDO instance: 436 RPC requests, active time 8.85 s, billed duration 1.13 GB-s (0.0026 GB-s per request), CPU 0.29 s (0.67 ms per request), rows read 560, rows written 761. Workers Paid includes 1 M DO requests, 400,000 GB-s, 25 B rows read and 50 M rows written per month; beyond that $0.15 per M requests, $12.50 per M GB-s, $0.001 per M rows read, $1.00 per M rows written, $0.20 per GB-month beyond 5 GB.

| Scenario (guess for traffic)                            | DO requests             | Duration                                        | Rows written         | Incremental cost                    |
| ------------------------------------------------------- | ----------------------- | ----------------------------------------------- | -------------------- | ----------------------------------- |
| 1 store, 100 k requests/month                           | inside the 1 M included | 260 GB-s, included                              | included             | **$0** over the $5 base             |
| 1,000 stores x 100 k = 100 M requests/month, 20% writes | 99 M billable = $14.85  | 260,000 GB-s, still inside the 400,000 included | about 34 M, included | **about $15/month**                 |
| Neon today (Ahmad, 2026-10-24)                          |                         |                                                 |                      | $19 at launch size, about $65 grown |

Every RPC call on a stub is its own billed DO request, so the repo layer must batch reads per page (one call, not one per table). Storage of the whole production database is 26 MB (measured), so storage cost is nil at launch.

### Backup and restore (measured live)

Nightly alarm (`alarm()` re-arms +24 h even when the export throws), exports NDJSON per table plus a manifest with rows and sha256 to the EXISTING bucket `ebda-private` under `store-do-backups/<store>/<date>/` (manifest written last; a day without one is incomplete and ignored). Restore loads into a FRESH DO instance and re-hashes: 7 of 7 tables equal. PITR: `getCurrentBookmark()` works in production (30-day bookmarks), so per-store point-in-time restore is available as a second path. NOT verified live: the alarm firing itself (armed at seed time, fires about 24 h later; verified locally with `runDurableObjectAlarm`), and D1 Time Travel (no D1 exists yet, and Ruling INFRA-PREVIEW-1 forbids creating one for the spike).

## Surprises that change Phase 1 (all new)

1. **100 columns per table, 100 bound parameters per query** (Cloudflare DO SQLite limits). Measured on `schema.prisma`: only `Store` exceeds 100 columns (105), and it is already split between the D1 directory and the DO settings (task 1.4), so the split must also be column-count-driven, not only semantic. Every `IN (...)` list, bulk insert and import must chunk at 100 parameters; add a lint-style test in the repo layer (task 2.1).
2. **Scale is tiny.** Production has 6 stores, 6 admin users, 0 customers, 0 passkeys, 12 refresh tokens, and the database is 26 MB. The largest demo store has 28 products. No store comes near the 10 GB per-DO limit or the 128 MB memory limit; the backup export reads a whole store in memory safely at this size (revisit with a paged export at about 50 MB per store).
3. `drizzle-orm` `run()` returns void: use `.returning()` for guarded stock updates (done in `repo.ts`). Drizzle's DO driver is synchronous, so a money section is one `transactionSync` with no await by construction.
4. Worker bundle cost of the whole spike inside `ebda-api`: startup CPU 89 ms (gate 140), bundle 14.74 MB (gate 14.8 MB, 60 KB headroom). The next large dependency needs a budget Ruling.
5. Process: the single CI runner pair serialises PRs (45 to 60 minutes each); batch phase tasks into fewer, larger PRs.
6. Not a finding but a risk I created: the baseline run left about 300 guest carts on the demo store in Postgres (allowed by the guest-write rule; they are demo data).

## Identity (Rulings ID-1, ID-2) and the two contracts

- **Does the spike change the identity or WhatsApp contracts? No.** The DO needs only a verified `sub`, `stores[]` and `aud=store`; the entity index and the D1 directory carry user to store lookups. Queues and Service Bindings are callable from a DO's Worker (the DO runs in the same Worker), so `ebda-wa-events` / `ebda-store-events`, the `WhatsAppBridge` RPC, `store.plan_changed` and the buyerKey HMAC are unaffected.
- **Do sessions survive the move? No: plan for ONE re-login per merchant.** The refresh cookie today lives on `api.ebda.app`; the contract puts it on `accounts.ebda.app`, and a browser cannot hand a cookie to another domain. Access tokens (HS256, 30 min) are never accepted after the cutover. Cost: 6 admin users and 12 refresh tokens, so negligible before launch.
- **Passkeys (0 today) stay valid only if the WebAuthn ceremony still runs from the same origin**: each credential stores its `rpId` (`passkey_credentials.rp_id`), and a browser refuses a different RP ID. So the login UI must stay on the admin origin and call the accounts Worker, with the accounts Worker verifying against an origin allow-list. Hosting the login page on `accounts.ebda.app` would strand any existing admin passkey.
- Customers (`users.store_id` set) are Store data, not Ebda-account identities; they move with the store into the StoreDO (Ruling ID-3, below).

## Estimate for Phase 1 onward, after the gap-closure Rulings (guess)

Inputs from the controller: Inngest to Workflows/Queues/DO alarms/Cron; Resend to Cloudflare Email Service; demo stores re-seeded with no merchant data migration (only qa-walk and users); CI-1 fields in the new schema; old skins deleted before Phase 1; backups to R2 plus a nightly copy to the Mac.

| Phase                                                         | Original    | Now                 | Why                                                                                   |
| ------------------------------------------------------------- | ----------- | ------------------- | ------------------------------------------------------------------------------------- |
| Identity service first (ID-2)                                 | not planned | **about 1.5 weeks** | auth Worker, D1, ES256/JWKS, 5 PRs plus Opus security review                          |
| 0 spike                                                       | 2 to 3 days | done                |                                                                                       |
| Skin deletion                                                 | not planned | 1 to 2 days         | removes work from the schema port and parity tests                                    |
| 1 schema port                                                 | 3 to 4 days | 3 to 4 days         | CI-1 fields included; column-count rule added                                         |
| 2 repo layer (279 raw SQL sites, 43 locks)                    | 1 week      | 1 week              | unchanged; 100-parameter chunking added                                               |
| 3 money, stock, gold, refunds                                 | 1 week      | 1 week              | unchanged; Opus review required                                                       |
| 4 migration tooling                                           | 3 to 4 days | **about 1 day**     | G4: re-seed demo stores, qa-walk plus users only; no merchant data to move            |
| 5 per-store cutover                                           | 3 to 4 days | **about 1 day**     | nothing to dual-read except demo stores                                               |
| 6 jobs (95 Inngest functions to Workflows/Queues/alarms/Cron) | 1 week      | **1.5 to 2 weeks**  | the whole Inngest estate moves, not only per-store crons                              |
| 7 decommission                                                | 3 to 4 days | 3 to 4 days         | Resend and Inngest removal added; Neon deletion still needs Ahmad's explicit approval |

Net (guess): about 5 to 6 weeks of agent work from today instead of 3 to 4, almost all of the increase being identity (1.5 weeks) and the Inngest replacement (1 week), offset by about 1 week saved in phases 4 and 5. Launch stays gated on this.

## Conditions on GO

1. Phase 2 starts by moving host-to-store resolution to the D1 directory; without it the DO path inherits the Frankfurt hop and the headline latency win stays at the floor measured here.
2. Phase 3 re-measures order create like-for-like (local Postgres vs DO, same SQL shape) and reports p95 before any money path moves; today's order-create comparison is not a gate result.
3. The Worker bundle/startup budget is tracked per phase (60 KB headroom).

## Rulings

Ruling INFRA-CF-3 - GO to Phase 1 on the evidence above, conditional on the three conditions. Cost if wrong: about two weeks of schema-port and repo-layer work built on a DO model that Phase 3 could still reject, bounded because the Postgres path stays untouched until Phase 5.
Ruling ID-3 - the shared identity service owns merchants, staff and super admins (`users.store_id IS NULL`); store customers stay Store-owned (HS256, store-scoped) and move into the StoreDO. Cost if wrong: customers would need a second extraction later; at 0 customers today the cost is nil, and the token contract already carries only `stores[]` for operators.
