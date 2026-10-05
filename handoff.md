# Ebda UI handoff

## Goal
Assess launch readiness, remove exposed FWB naming, improve UI and fix wiring/errors; prove backend operation in Cloudflare workerd. Mobile is mandatory end-to-end.

## Current state
Branch `codex/ebda-ui-ux`, worktree `/private/tmp/ebda-ui-20261005`, baseline `89461087`. Root `plan` and unrelated `.handoff/` preserved. PR #3: https://github.com/Whisky-11/ebda/pull/3. Initial UI commits `9d047026`/`0a91f0ce`; expanded launch fixes `23acd07b` committed for PR #3. No merge/deploy. Local built Worker preview: http://localhost:8788/signup.

## Done
UI implementation, bilingual browser checks, 131 targeted tests, admin typecheck, final OpenNext build and Wrangler dry run. Local workerd signup/logo 200; browser rendered both languages. CF generated routes corrected to BRAND authority. AST graph refreshed. Exact evidence and rulings: docs/ebda/ui/2026-10-05-merchant-ui-verification.md.

## In progress
Local implementation and verification complete; review PR delivery complete after remote verification. Full unit suite 6,762 passed, plus deployment-config guard; 29 workerd tests; strict-role two-store cron integration; complete local signup→COD order flow; actual admin signup against local Worker passed.

## Left to do
Live launch needs migrated strict-role Neon URL, provisioned Hyperdrive/KV/queues, GitHub CF inputs, Worker secrets, sender/DNS and real provider/UAT proof. Manual API deployment workflow is now prepared, not dispatched. Dependency audit retains 14 high upstream build-tool findings (braces/extract-zip); available FTP fix applied. Live API/payment/order verification requires backend and authorized production checks. Review/merge/deployment belongs to Ahmad's subsequent authorization.

Rulings UI-1 through UI-4: docs/plans/2026-10-05-ebda-merchant-ui.md. UI-5 through UI-7: verification document. Scope keeps payments/money/entitlements/merchant storefront palettes unchanged; only generated CF routing follows owner Cloudflare steering.

Expanded proof and rulings: docs/ebda/launch-readiness-2026-10-05.md. Local API 4896, isolated PG 55439. No production writes.

Neon inventory could not be read: CLI required authentication; the pending login was cancelled. Existing production database presence is unverified.
