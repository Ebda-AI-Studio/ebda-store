/**
 * NEON-ZERO (Postgres removed from the Worker 2026-11-05): a route handler that calls `prisma.<model>` reaches the
 * Postgres-removed client and answers 500 POSTGRES_REMOVED for a Durable Object store. This gate keeps the class from
 * growing back:
 *
 *   1. The MONEY routes (payments, gateway webhooks / callbacks, payment reports, affiliate payouts) may not call `prisma.`
 *      at all: their reads go through `storeDb(storeId)` (the `prisma` proxy for a Postgres store, prisma-lite on the DO) and
 *      their writes through the StoreDO money ops (`storeMoney`) or a service that branches on it. No allowlist entry exists
 *      for them, by design.
 *   2. Every other route file is a RATCHET: its count of `prisma.` sites may only go down. A new file with a `prisma.` call,
 *      or a file that gains one, fails here. Each entry names WHY the remaining sites do not reach Postgres for a DO store,
 *      or that they are unported (tracked in docs/cf/neon-zero-remaining.md).
 *
 * The runtime half is apps/api/workers-test/money-path.test.ts (signed webhooks + checkout with Postgres absent) and the
 * strict route sweep (SWEEP_STRICT=1).
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../../apps/api/src/routes');
const API_SRC = join(__dirname, '../../apps/api/src');
const BASELINE = join(__dirname, 'prisma-sites-baseline.json');

/** Money routes: ZERO `prisma.` sites, never allowlisted. */
const MONEY_ROUTES = [
  'payment.routes.ts',
  'webhook.routes.ts',
  'payment-abandonments.routes.ts',
  'affiliate.routes.ts',
];

const D1 =
  'model routed to D1 / the DO by the platform model router (services/platform/router.ts) on the Worker';
const UNPORTED = 'unported for a DO store: listed in docs/cf/neon-zero-remaining.md';

/** file -> the most `prisma.` sites it may have, and why they are there. Lower a number when you port a site; never raise it. */
const RATCHET: Record<string, { max: number; reason: string }> = {
  'admin-search.routes.ts': { max: 3, reason: `customer/user: ${UNPORTED}` },
  'admin.routes.ts': {
    max: 26,
    reason: `store/aiUsage/storeStaff: ${D1}; user/auditLog: ${UNPORTED}`,
  },
  'agent-credential.routes.ts': { max: 3, reason: `store: ${D1}` },
  'ai.routes.ts': { max: 4, reason: `aiUsage: ${D1} (ai-usage family)` },
  'billing.routes.ts': { max: 1, reason: `store: ${D1}` },
  'bundle.routes.ts': { max: 5, reason: `bundle/$transaction: ${UNPORTED}` },
  'campaign.routes.ts': { max: 3, reason: `store: ${D1}; user: ${UNPORTED}` },
  'category.routes.ts': { max: 1, reason: `$transaction: ${UNPORTED}` },
  'customers.routes.ts': { max: 1, reason: `user: ${UNPORTED}` },
  'feature.routes.ts': { max: 1, reason: `user: ${UNPORTED}` },
  'finance.routes.ts': { max: 16, reason: `bank statements / journals / fx: ${UNPORTED}` },
  'fiscal-document.routes.ts': { max: 1, reason: `store: ${D1}` },
  'insights.routes.ts': { max: 6, reason: `order/orderItem reports: ${UNPORTED}` },
  'merchant-key.routes.ts': { max: 5, reason: `merchantApiKey/store: ${D1} (platform family)` },
  'merchant-webhooks.routes.ts': { max: 1, reason: `$executeRaw: ${UNPORTED}` },
  'notification.routes.ts': { max: 4, reason: `notificationLog: ${UNPORTED}` },
  'order.routes.ts': {
    max: 5,
    reason:
      'payment/order/$transaction: the Postgres branch of bulk-mark-paid and refresh-refund-status (single mark-paid moved to OrderService.markCodPaid), reached ONLY when storeMoney(storeId) is null (a Postgres store); a DO store takes the money op and returns first',
  },
  'payment-settings.routes.ts': { max: 6, reason: `store: ${D1}` },
  'provider-activation.routes.ts': { max: 1, reason: `store: ${D1}` },
  'public.routes.ts': { max: 2, reason: `$queryRaw definers: ${UNPORTED}` },
  'shipping-carrier.routes.ts': { max: 1, reason: `user: ${UNPORTED}` },
  'store.routes.ts': { max: 8, reason: `store: ${D1}; auditLog: ${UNPORTED}` },
  'wallet.routes.ts': {
    max: 1,
    reason:
      'user: the Postgres fallback of assertStoreCustomer, reached ONLY when customerRow() answers undefined (a Postgres store); a DO store reads its own customer row',
  },
};

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(f => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return routeFiles(p);
    return /\.ts$/.test(f) && !/\.test\.ts$/.test(f) ? [p] : [];
  });
}

/** `prisma.` call sites, comments stripped (a comment that NAMES the old call is not a call). */
function prismaSites(src: string): number {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  return (code.match(/\bprisma\s*\.\s*\$?[A-Za-z]/g) ?? []).length;
}

const counts = new Map(
  routeFiles(ROOT).map(p => [relative(ROOT, p), prismaSites(readFileSync(p, 'utf8'))])
);

describe('no prisma.<model> in Worker route handlers (NEON-ZERO)', () => {
  it('the money routes have none (reads via storeDb, writes via the StoreDO money ops)', () => {
    const bad = MONEY_ROUTES.filter(f => (counts.get(f) ?? 0) > 0).map(
      f => `${f}: ${counts.get(f)}`
    );
    expect(bad).toEqual([]);
    for (const f of MONEY_ROUTES)
      expect(RATCHET[f], `${f} must never be allowlisted`).toBeUndefined();
  });

  it('every other route file stays at or under its ratchet, and a new prisma call needs a reasoned entry', () => {
    const over: string[] = [];
    for (const [file, n] of counts) {
      if (n === 0) continue;
      const entry = RATCHET[file];
      if (!entry) over.push(`${file}: ${n} prisma call(s), no allowlist entry`);
      else if (n > entry.max) over.push(`${file}: ${n} > ${entry.max}`);
    }
    expect(over).toEqual([]);
  });

  it('the counter sees a call and ignores a comment (self-test)', () => {
    expect(prismaSites('await prisma.order.findFirst({})')).toBe(1);
    expect(prismaSites('await prisma.$transaction([])')).toBe(1);
    expect(prismaSites('// prisma.order.findFirst\n/* prisma.payment.create */')).toBe(0);
    expect(prismaSites("const u = 'https://x'; await prisma.user.findMany()")).toBe(1);
  });
});

/**
 * The same class OUTSIDE the route files (P1 2026-11-09: `ProductService.listPublic` `sort=on_sale` ran a raw Postgres statement
 * from a SERVICE, so the route ratchet above never saw it, and the route sweep hits each route once with no query string).
 * Every `prisma.` site in apps/api/src (services, lib, jobs, mcp...; routes are ratcheted above) is pinned per file in
 * `prisma-sites-baseline.json`: a new file with a call, or a file that gains one, fails here. Port the call to `storeDb` /
 * `storeWriter` / `storeMoney` / D1 instead. After porting, lower the baseline with
 *   UPDATE_PRISMA_BASELINE=1 npx vitest run tests/unit/no-prisma-in-routes.test.ts
 * (it refuses to write while any file is OVER its baseline, so it can only ratchet down).
 */
describe('no new prisma.<x> call anywhere in the Worker source (NEON-ZERO ratchet)', () => {
  const nonRoute = new Map(
    routeFiles(API_SRC)
      .filter(p => !p.startsWith(ROOT) && !/__tests__/.test(p))
      .map(p => [relative(API_SRC, p), prismaSites(readFileSync(p, 'utf8'))] as const)
      .filter(([, n]) => n > 0)
  );
  const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) as Record<string, number>;

  it('every non-route file stays at or under its pinned count; a new file needs none', () => {
    const over: string[] = [];
    for (const [file, n] of nonRoute) {
      const max = baseline[file];
      if (max === undefined) over.push(`${file}: ${n} prisma call(s), not in the baseline`);
      else if (n > max) over.push(`${file}: ${n} > ${max}`);
    }
    expect(over, 'port these to storeDb / storeWriter / storeMoney / D1').toEqual([]);
    if (process.env.UPDATE_PRISMA_BASELINE === '1') {
      const sorted = Object.fromEntries([...nonRoute].sort(([a], [b]) => a.localeCompare(b)));
      writeFileSync(BASELINE, JSON.stringify(sorted, null, 2) + '\n');
    }
  });

  it('the baseline names no file that no longer has a call (it only ever shrinks)', () => {
    const stale = Object.keys(baseline).filter(f => !nonRoute.has(f));
    expect(stale, 'rerun with UPDATE_PRISMA_BASELINE=1 to drop them').toEqual([]);
  });
});
