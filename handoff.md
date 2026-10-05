# Ebda UI handoff

## Goal
Adapt FWB UI to Ebda branding, clarify merchant setup, require signup mobile in UI, verify Cloudflare and push a reviewable branch.

## Current state
Branch `codex/ebda-ui-ux`, worktree `/private/tmp/ebda-ui-20261005`, baseline `89461087`. Root `plan` and unrelated `.handoff/` preserved. No merge/deploy. Local built Worker preview: http://localhost:8788/signup.

## Done
UI implementation, bilingual browser checks, 131 targeted tests, admin typecheck, final OpenNext build and Wrangler dry run. Local workerd signup/logo 200; browser rendered both languages. CF generated routes corrected to BRAND authority. AST graph refreshed. Exact evidence and rulings: docs/ebda/ui/2026-10-05-merchant-ui-verification.md.

## In progress
Commit/push/PR and final branch verification.

## Left to do
Claude: make merchantSignupSchema.phone required server-side. API still accepts an omitted number. Live API/payment/order verification requires backend and authorized production checks. Review/merge/deployment belongs to Ahmad's subsequent authorization.

Rulings UI-1 through UI-4: docs/plans/2026-10-05-ebda-merchant-ui.md. UI-5 through UI-7: verification document. Scope keeps payments/money/entitlements/merchant storefront palettes unchanged; only generated CF routing follows owner Cloudflare steering.
