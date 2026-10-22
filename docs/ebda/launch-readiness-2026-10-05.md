> **RETIRED, HISTORICAL — 2026-10-10.** Superseded by `docs/ebda/evidence-hierarchy.md` (Ahmad's binding decision, FIX-016). Several claims below are now factually wrong — most importantly "this is not yet a verified live deployment": the API, admin, web and orders are now confirmed live on Cloudflare Workers (see `docs/ebda/truth-table-2026-10.md` §5). Kept only as a record of what the 2026-10-05 snapshot believed. Do not cite this file for a readiness claim, and make NO public launch claim from any document until an unaided merchant completes the full journey (see evidence-hierarchy.md §0).

# Ebda launch readiness — 2026-10-05

Core backend wiring runs in local Cloudflare workerd. This is not yet a verified live deployment.

| Surface                                     | Evidence                                                                                                                     | Launch status                                                                                        |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Merchant signup/mobile/email verification   | Strict-role local workerd E2E passed; dev mail captured, mobile required in UI + API                                         | Real sender/domain delivery still needs verification                                                 |
| Store/template/product/payment setup        | Local Worker E2E, bilingual UI tests and OpenNext build                                                                      | Wired locally                                                                                        |
| Storefront/cart/COD/order/dashboard guide   | Full HTTP flow passed in 4.3 seconds including 3.2-second antibot wait; synthetic order only                                 | Wired locally                                                                                        |
| Tenant isolation/queues/DO/cron             | 29 workerd tests; two-store strict-role cron writes verified                                                                 | Real Hyperdrive edge/pooling still unverified                                                        |
| UI/error handling/branding                  | Ebda gold/charcoal, required mobile, back-navigation preserves store, resend failures shown                                  | Review branch ready after final checks                                                               |
| Cloudflare deployment                       | API routes + manual main-only deployment workflow prepared, binding-ID and secret presence gates                             | Company inventory has no Hyperdrive configs and no Ebda KV; GitHub repo secrets/variables list empty |
| Gateways/carriers/uploads/realtime delivery | Existing adapters and prior stub evidence; this phase did not drive real providers/uploads or authenticated delivered events | Requires actual sandbox inputs and end-to-end verification                                           |

## Fixes

Worker role validation blocks unsafe/missing/failed role checks before application work and caches only success. Website abandoned-cart detection/reminder sends and loyalty birthday/expiration jobs run in tenant scopes. Both cron fixes proved real writes for two tenants as `ebda_app`, with zero bypass.

Cloudflare API has explicit `api.ebda.app` custom domain plus its zone route so storefront wildcard routing cannot take its traffic. Next CF builds bake the Ebda API origin from BRAND if no override exists (web includes `/api/v1`; admin/orders use the origin). Runtime Worker variables cannot repair already-compiled `NEXT_PUBLIC_*` values.

Root package/repository metadata now names Ebda/Whisky-11. Public naming sweep found no Ebda Store labels in merchant/signup/storefront surfaces; stored compatibility keys, JWT audiences, workspace names and inherited history remain deliberately stable.

## Remaining inputs and proof

Provision a migrated Ebda Neon database and strict `ebda_app` role, then use `apps/api/scripts/cf-hyperdrive-create.sh` with its existing `HYPERDRIVE_CONNECTION_STRING` input. The helper verifies the live role and disables query caching. Provision Ebda KV and all declared queues/DLQs; DO migrations are already declared. Configure GitHub deployment token/account and `EBDA_HYPERDRIVE_ID`/`EBDA_KV_CACHE_ID`; configure Worker JWT/encryption/Resend secrets and verified mail sender. Confirm Ebda zone/DNS and marketing Pages origin.

The manual workflow does not run on push or PR. It generates ignored deployment config, checks required runtime-secret names, deploys only from main and compares `/health.commit` to GitHub SHA. It was not dispatched. Live buy-flow, email and edge-load proof are required before merchant launch. Real purchase/provider charge was not performed.

## Security/dependency ruling

Ruling LAUNCH-2 — apply available basic-ftp 6.2.2 leaf patch without major application-tool upgrades. Registry evidence: basic-ftp <=6.2.0 is affected. Cost if wrong: FTP tooling compatibility regression; application flows do not use FTP.

Ruling LAUNCH-3 — remaining braces/extract-zip advisories block a zero-vulnerability launch claim. Registry latest versions (3.0.3/2.0.1) are still affected; broad force-upgrades are not a proven patch for every consumer. These enter through build/browser audit tooling; use repository-owned glob patterns and vendor browser archives only. Full audit still reports 14 high findings; omit-dev audit reports four via site-kit Lighthouse. Cost if wrong: a malicious glob/archive reaches tooling. Track upstream patched versions and rerun gates; do not claim this is zero-vulnerability.

Ruling LAUNCH-4 — initial broad unit failures were largely sandbox test-server denial, not established product defects. An unrestricted rerun passed 6,752 with ten failures isolated to generator fixtures/action pins; both fixed. Cost if wrong: genuine route defects could be hidden; final full-suite result must be recorded below.

## Evidence paths

Local logs `/private/tmp/ebda-launch-{workers-test,flow,strict-cron,final-targeted,unit-final,api-final-typecheck,admin-final-build,dependency-audit,runtime-audit}.log`. Local DB is isolated on port 55439, never production. Local API Worker port 4896; UI preview port 8788. No production database mutation, merge or deploy occurred.

## Final checks

Full unit suite: 6,762/6,762 passed across 494 files. API typecheck and final OpenNext admin build passed. Focused API/merchant regressions: 60 tests passed. Worker: 29 passed. Two-store strict-role cron integration passed. Browser on the rebuilt admin Worker proved an omitted mobile is refused and a filled signup succeeds against the actual isolated backend. CSP now permits only the explicitly configured API origin (HTTPS, or loopback HTTP for local tests), plus existing service destinations.

Blast-radius: swept mobile/signup, COD state, resend, tenant cron scopes, role guard, API host/build vars, deployment IDs and naming across apps/packages/scripts/CI/docs/env examples; read sibling Ebda Store sources without changing them. Fixed related route, generator-fixture, JSONC-parser and action-pin gaps. Compatibility identifiers are documented above.

Additional deployment-config guard test passed. Secretlint covered all 35 non-generated staged files; gitleaks scanned the 37 MB staged patch with no leaks. Neon CLI inventory required authentication and was cancelled; no assertion is made that an Ebda Neon project is absent.

Ruling LAUNCH-5 — keep Worker-suite runtime warnings unresolved in the launch checklist: the passing suite also logged “Network connection lost” and an event-handler returned-value warning. No source was established from the runtime output, so these are not declared fixed or proven production defects. The independent local buy-flow passed; live edge/realtime verification must establish whether they reproduce before launch. Cost if wrong: an actual dropped connection is mistaken for test teardown behavior.
