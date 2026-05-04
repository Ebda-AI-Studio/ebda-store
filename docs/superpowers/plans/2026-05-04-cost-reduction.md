# FWB cost-reduction plan — 2026-05-04

## Context (read first)

This plan implements code-only changes to keep FWB on free-tier services. **No service relocations** — keep Vercel, Neon, Railway, R2, Resend, OneSignal, Inngest, Gemini exactly where they are.

### Verified state (dashboard screenshots 2026-05-04)

- **FWB Neon project at 11.35 CU-hrs in 3.5 days → projecting ~97 CU-hrs/mo against the 100 CU-hr free cap. About to hit.** This is the most urgent finding across all Force projects.
- FWB Neon storage 40 MB / 0.5 GB (8%) — fine.
- Vercel Hobby account-wide: bandwidth 0.9%, function invocations 7%, image-optimization transformations 1.8K/5K (36%), all other metrics low single digits.
- R2 total 568 MB / 10 GB (5.7%) across all 3 buckets.
- Inngest production: 7 functions, only `Hourly heartbeat` has any volume (24/day).
- Gemini `gemini-flash-lite-latest` has ~30 RPM free; existing throttle at 2500ms (~24 RPM) — but no daily/monthly cap.

### Why this matters

FWB is the highest-traffic project and the binding free-tier cap is its Neon compute hours. Without these changes the project will hit the cap by month-end and Neon will throttle/suspend production.

## Phase 1 — URGENT (this week)

### Task 1.1 — Cap Google AI requests in FWB to stay within free tier

**Problem:** Bulk SEO/translate sweeps + per-form AI calls all share one Gemini API key. A single bulk run could blow through the daily free quota and start failing all AI features for the rest of the day. There's an RPM throttle (`AI_BULK_THROTTLE_MS=2500`) but no daily/monthly volume cap.

**Where:**

- Find the central Gemini call site. Likely `apps/api/src/lib/ai-helper.ts` or similar shared helper. Check `apps/api/src/services/ai/*` and `apps/api/src/routes/*ai*`.
- `AiUsage` Prisma model already exists per the project schema (per `docs/superpowers/plans/ai-features.md`).

**Change:**

1. Add env vars to `apps/api/.env.example` and Railway config:
   - `AI_DAILY_REQUEST_CAP=1000` (configurable; conservative for free tier — Google's free tier daily quota is typically 1500/day for `flash-lite`)
   - `AI_MONTHLY_REQUEST_CAP=20000`
2. Wrap every Gemini call with a pre-check helper:
   ```ts
   // apps/api/src/lib/ai-quota.ts (new file)
   export async function assertAiQuota() {
     const startOfDay = new Date();
     startOfDay.setUTCHours(0, 0, 0, 0);
     const startOfMonth = new Date();
     startOfMonth.setUTCDate(1);
     startOfMonth.setUTCHours(0, 0, 0, 0);
     const [today, thisMonth] = await Promise.all([
       prisma.aiUsage.count({ where: { createdAt: { gte: startOfDay } } }),
       prisma.aiUsage.count({ where: { createdAt: { gte: startOfMonth } } }),
     ]);
     const dailyCap = parseInt(process.env.AI_DAILY_REQUEST_CAP ?? '1000', 10);
     const monthlyCap = parseInt(process.env.AI_MONTHLY_REQUEST_CAP ?? '20000', 10);
     if (today >= dailyCap)
       throw createError(
         'AI_QUOTA_DAILY_EXCEEDED',
         `Daily AI quota reached (${today}/${dailyCap}). Resets at 00:00 UTC.`
       );
     if (thisMonth >= monthlyCap)
       throw createError(
         'AI_QUOTA_MONTHLY_EXCEEDED',
         `Monthly AI quota reached. Resets next month.`
       );
   }
   ```
3. Call `assertAiQuota()` at the entry of every Gemini-calling function. Highest priority: `bulk-ai-translate.ts`, `bulk-ai-seo.ts`, per-form AI buttons.
4. Bulk sweep loops: check the cap before EACH iteration (not just at start) so a long sweep cleanly stops mid-run rather than hitting Google's 429.
5. Surface clean error in admin UI. Map `AI_QUOTA_DAILY_EXCEEDED` / `AI_QUOTA_MONTHLY_EXCEEDED` codes in the admin AI tools page to bilingual user-facing copy.

**Verify:**

- Set `AI_DAILY_REQUEST_CAP=2` temporarily on a dev DB, run 3 sequential AI calls, confirm 3rd one fails cleanly with the user-facing message.
- Run a bulk sweep with cap of 5 against a catalog of 20 items, confirm it stops at iteration 5 with no partial corruption.
- Check `prisma.aiUsage.count` increments on each successful call (probably already does — verify the existing increment).

### Task 1.2 — Reduce FWB Neon compute draw to stay under 100 CU-hr free cap

**Problem:** FWB API is generating 3.24 CU-hrs/day of Postgres compute. Projects to ~97 CU-hrs/mo against the 100 CU-hr free cap. Hits cap in ~28 days.

**Where:** Several levers in priority order:

1. **Reduce admin polling intervals.** Audit every TanStack `useQuery` `refetchInterval` in `apps/admin/src/`:

   ```bash
   grep -rn "refetchInterval" apps/admin/src/
   ```

   Tighten any sub-30s intervals. For idle data (categories, settings, products list), 60s is plenty. For inventory/orders, 15–30s OK.

2. **Confirm `refetchIntervalInBackground: false` in QueryProvider.** WBS already did this 2026-05-03; verify FWB's `apps/admin/src/providers/QueryProvider.tsx` (or equivalent) has it set as default. If not:

   ```ts
   const queryClient = new QueryClient({
     defaultOptions: {
       queries: {
         staleTime: 60_000,
         refetchOnWindowFocus: false,
         refetchIntervalInBackground: false,
       },
     },
   });
   ```

3. **Tighten Redis caching on storefront store-resolver.** Per existing `feedback-cache-cost-tradeoff` rule (2-min minimum TTL). Audit `apps/api/src/services/store.service.ts` and surrounding for any `cacheService.wrap()` calls with TTL <120s; bump to 120s+.

4. **Reduce Neon `suspend_timeout` for FWB project from default 5 min to 2 min.** This is a Neon dashboard setting (Neon project → Settings → Compute → Suspend timeout). Trades a bit more cold-start latency for fewer billable compute hours.

**Verify after 24 hours:**

- Re-check FWB Neon compute usage in the dashboard. Daily rate should drop from 3.24 CU-hrs/day to under 3.0 CU-hrs/day (a 10–20% drop is realistic).
- If still trending past 100 CU-hr by month end, fall back to Plan B: upgrade just FWB Neon project to Launch (~$10–15/mo at this rate). User decision.

### Task 1.3 — Audit + remove unused Inngest functions

**Problem:** Production Inngest has 7 functions but only `Hourly heartbeat` shows any volume. Dead handlers add cold-start surface and can fire unexpectedly if events get sent.

**Where:** `apps/api/src/inngest/*.ts`

**Change:**

1. Confirm each function is actually wired to a real event source. The 6 zero-volume functions:
   - `Archive + delete audit_logs older than 90d` (cron `0 3 * * 0`) — keep, runs weekly
   - `Bulk: generate missing SEO meta across catalogue` — keep, on-demand bulk sweep
   - `Bulk import products from CSV` — keep, on-demand
   - `Bulk: translate missing EN/AR across catalogue` — keep, on-demand
   - `Email order invoice to customer` — keep, on `order/invoice.email-requested` event
   - `Order created — email + push + dispatcher fan-out` — keep, on `order/created` event
2. **Question `Hourly heartbeat`** — what does it do? Check the function body. If it's a leftover dev/heartbeat that doesn't drive any real behavior, remove it. 24 invocations/day is small but pointless if unused. If it serves a purpose (uptime ping, lock-renewal, etc.), document it inline.

**Verify:** Inngest dashboard volume drops to event-triggered-only after deploy.

## Phase 2 — Code changes that pay back at scale (1 week, low risk)

### Task 2.1 — Cache TTL lint rule

Add an ESLint rule disallowing `cacheService.wrap()` TTL < 120s outside an explicit allow-list (inventory, orders, prices). Enforces existing `feedback-cache-cost-tradeoff` rule from project memory.

Where: `eslint.config.mjs` or `.eslintrc` — add a `no-restricted-syntax` rule matching `CallExpression[callee.object.name='cacheService'][callee.property.name='wrap']` with the second argument being a literal < 120000.

Verify: deliberately add a 30s TTL somewhere, run `npm run lint`, see it flagged.

## Out of scope (don't implement)

The cross-project memory analyzed and dropped these — leave them alone:

- Cloudflare Pages migration (relocation)
- Cloudflare Images for storefront (36% of cap, not needed yet)
- Neon project consolidation (would actually save $0)
- Redis instance consolidation (relocation)
- Right-sizing Railway (already at 18% of credit)

## Reference

- Cross-project memory: `~/.claude/projects/-Users-ahmadsharaf-Desktop-projects-whatsapp-bulk-sender/memory/cross-project-pricing-and-cost-plan-2026-05-04.md`
- This project's verified Neon usage: 11.35 CU-hrs in 3.5 days, 40 MB storage, 1 production branch
