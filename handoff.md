# Handoff — D2 email campaigns

_Updated 2026-09-25. Branch `feat/d2-email-campaigns`, worktree
`_worktrees/force-website-builder__feat-d2-email-campaigns`, off `origin/main` @ `64490754`. The
previous contents of this file described the agent-key admin UI branch (merged as #1617); that
work's rulings live in `docs/superpowers/specs/2026-07-22-agentic-checkout-mcp-design.md` §10._

## Goal

Ship email campaigns behind the per-store `email_campaigns` feature key without breaking the 3
live stores: OFF for every store by default, nothing sends unless a merchant explicitly creates
and sends a campaign. Spec + plan: `docs/plans/2026-09-25-email-campaigns.md`. Rulings EC-1…EC-10:
`docs/RULINGS.md` (2026-09-25).

## Current state

All code, tests and docs are committed on the branch; PR open against `main` (not merged).
Migration `20260925120000_email_campaigns` is DDL-only (+ `rollback.sql`), verified on a
throwaway Postgres 16 (apply → rollback → re-apply).

## Done

- Database: `campaigns` + `campaign_recipients`, UNIQUE(campaign_id, email), RLS on both.
- Shared: feature un-hidden (still in no baseline), campaign Zod schemas.
- API: admin routes `/stores/:storeId/campaigns` (feature-gated), public unsubscribe
  `/public/campaigns/unsubscribe`, Inngest `campaign-send`, AI draft, erasure extended to
  newsletter + campaign rows, legacy newsletter broadcast no longer leaks addresses (EC-6).
- Web: `/unsubscribe` bilingual confirm page.
- Admin: Marketing → Campaigns list / editor / detail with per-recipient status.
- Tests + mutation proof (consent filter, idempotency guard, feature gate, token check).

## In progress

Nothing.

## Left to do

- First real send through Resend on a test store (headers, rendering, Gmail unsubscribe UI).
- Follow-ups recorded as rulings: bounce webhook (EC-7), retire or gate the legacy newsletter
  broadcast (EC-6), checkout email-consent checkbox if customers should become an audience (EC-1).
