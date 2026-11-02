/**
 * Every `prisma.$transaction` on a request path is accounted for.
 *
 * THE CLASS
 *
 * `$transaction` is deliberately NOT proxied to the ambient tenant transaction
 * — `isProxiedProp` in `packages/database` rejects every `$`-prefixed name but
 * the raw helpers. So inside a request, `prisma.$transaction(...)` opens a
 * SEPARATE transaction on a DIFFERENT connection, which cannot see rows the
 * request has already written through the proxy: the outer transaction does
 * not commit until the response finishes.
 *
 * When the nested body then references one of those rows — typically by
 * foreign key — Postgres raises a constraint violation against a row that
 * exists but is invisible. `CartService.addItem` did exactly that (P2003 on
 * `cart_items.cart_id`, a 500 on the first add-to-cart of a session), and
 * `tenantContext` rolls back on a 5xx, so the client's retry reproduced it
 * rather than self-healing.
 *
 * WHY A REGISTRY AND NOT A BAN
 *
 * `addItems` carried this defect through THREE separate audit reports
 * (#1109, #1581, #1592) while its siblings were fixed twice around it. Each
 * report found the same sample; nothing made the CLASS visible. Most
 * `$transaction` uses are perfectly correct — they do not depend on an
 * uncommitted outer write — so banning the call would be noise. What was
 * missing is that a NEW one could appear and nobody would know to ask.
 *
 * So: every call site is either inside a `hasTenantContext()` branch, or named
 * below with a reason. Adding a `$transaction` to a service reachable from a
 * request fails this test until someone writes down which it is. That is the
 * whole point — the question gets asked once, at the moment it is cheap.
 *
 * This asserts on source text, and source text is weak evidence about
 * behaviour. It is not pretending otherwise: the behavioural gates are
 * `tests/unit/cart-ambient-tx.test.ts` (the branch is taken) and
 * `tests/integration/cart-nested-transaction.test.ts` (the P2003 is real,
 * against real Postgres). This one guards the ENUMERATION, which is the thing
 * that actually failed three times.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The whole API source tree, not just `services/` (#1787): route handlers,
 * Inngest functions and MCP tools open transactions too, and a route handler
 * is the MOST likely place for a new request-path one. Paths below are
 * relative to this root.
 */
const API_SRC = path.resolve(__dirname, '../../apps/api/src');

/**
 * Call sites reviewed and left on their own transaction, with why.
 *
 * A file is listed here ONLY when someone has read it and established that it
 * does not write-then-reference within one request. "I did not look" is not a
 * reason — use the unreviewed list below for that, which is deliberately
 * uncomfortable to leave entries in.
 */
const REVIEWED_OWN_TRANSACTION: Record<string, string> = {
  // Gold-rate pricing (Phase B5, Rulings B5-13/B5-17): every rate write is ONE money transaction that
  // takes an advisory lock and FOR UPDATE on the store's current rates, then writes history, current
  // rates, re-priced rows and (through the definer) audit rows. It reads only rows committed before
  // the request (rates, products, settings), and the request writes nothing through the proxy first.
  // The atomicity this needs (rate rows + every price commit or roll back together) is exactly what
  // its own transaction gives; tests/integration/gold-rate-apply.test.ts case 5 proves it.
  'services/catalog-import.service.ts':
    'variants are written by `withMoneyTx` in createDraftForItem, which only the catalog-import-create-drafts job calls inside `runInStoreScope` (per-query scope, each statement committed), so the draft product it references is already committed and visible; no request-path caller',
  'services/gold-rate/gold-rate.service.ts':
    'rate / settings / spec writes run in one money transaction (advisory lock + FOR UPDATE + repricer); no prior write in the request, reads only committed rows',
  // (AuthService.verifyEmail used to be listed here: it now runs `withUser`, which joins or opens
  // the user's own scope itself, so it no longer opens a bare `prisma.$transaction`.)
  // #1787 — the route-level sites the services-only scan could not see. Each
  // is an ARRAY batch of updates/upserts to rows that existed before the
  // request, referencing nothing but `storeId`; the handler writes nothing
  // through the proxy first, so there is no uncommitted row to be invisible.
  //
  // Measured 2026-09-25 against Postgres 16: a batch built from PROXIED
  // accessors inside `runInTenantContext` does NOT join the request
  // transaction. It runs on its own connection and commits even when the
  // request transaction then rolls back. (Since #1984 it starts with the same
  // RLS GUCs — `transactionWithGucs` — so it no longer reads strict tables as
  // empty; the separate commit is unchanged.) So these batches are atomic
  // among themselves but not with the rest of the request.
  // AI category apply (wave 2): one transaction creates the approved categories and their product links. It reads
  // only rows committed before the request (products, existing slugs), every write goes through `tx`, and the
  // handler writes nothing through the proxy first, so no uncommitted row can be invisible to it.
  'services/store-category-suggest.service.ts':
    'creates categories + product links in one transaction over committed products; no prior write in the request',
  'services/recommendation.service.ts':
    'setProductRelations replaces one source product relations in one batch (deleteMany + createMany through the store writer); no prior write in the request',
  'routes/category.routes.ts':
    'reorder batches (category.updateMany / productCategory.updateMany) over existing rows; no prior write in the request',
  'routes/product.routes.ts':
    'reorder batches (product.update) over existing rows; no prior write in the request',
  'routes/shipping.routes.ts':
    'area-rate upsert batches keyed on (storeId, country, governorate, area); reference only storeId; no prior write in the request',
  'routes/order.routes.ts':
    'COD mark-paid / bulk-mark-paid flip existing payment + order rows. Its own commit is load-bearing today: the handler enqueues `order/created` BEFORE the request commits, and the accounting consumer must read the order as paid. Moving the flip into the request transaction needs that send moved behind deferAfterTenantCommit first — see Ruling M5-3',
};

/**
 * Call sites that predate this registry and have NOT been checked for the
 * write-then-reference shape.
 *
 * This list is the finding, not the fix. It exists so the class is visible and
 * countable instead of invisible; every entry removed from it is either a
 * reviewed entry above or a `hasTenantContext()` branch. Do not add to it —
 * a new call site should be resolved when it is written.
 */
const UNREVIEWED_PREDATING_THIS_REGISTRY = new Set([
  'services/barcode-scan.service.ts',
  'services/bulk.service.ts',
  'services/customer-group.service.ts',
  'services/inventory.service.ts',
  'services/loyalty-automation.service.ts',
  'services/loyalty.service.ts',
  'services/shipping-carrier.service.ts',
  'services/shipping.service.ts',
  // Surfaced by widening the scan to all of apps/api/src and counting
  // `withMoneyTx(` — which calls `$transaction` on the caller's behalf, so the
  // literal never appears in the caller (#1787). Not yet reviewed for the
  // write-then-reference shape; listed so they are counted, not hidden.
  'lib/inngest/functions/bulk-ai-product-faqs.ts',
  // `w.$transaction([$proc])` is ONE Durable Object RPC (the DO twin of the guarded AI write), not a Postgres transaction
  'services/ai-autofill.service.ts',
  'lib/inngest/functions/order-refunded.ts',
  'services/accounting/purchase-order.service.ts',
  'services/accounting/stock-adjustment.service.ts',
  'services/feature.service.ts',
  'services/order.service.ts',
  'services/product.service.ts',
  'services/provisioning.service.ts',
  'services/store.service.ts',
  'services/variant.service.ts',
  'services/warehouse.service.ts',
]);

function sourceFiles(dir: string, rel = ''): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const next = path.join(dir, e.name);
    const relName = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) return e.name === '__tests__' ? [] : sourceFiles(next, relName);
    return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [relName] : [];
  });
}

/**
 * Source with comments blanked (line count preserved, so the proximity window
 * below still lines up), so a file that only DOCUMENTS the class (e.g.
 * `bundle.routes.ts` explaining why it does not open one) is not a caller.
 */
function code(file: string): string {
  return fs
    .readFileSync(path.join(API_SRC, file), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Opens its own transaction: directly, or through `withMoneyTx`. */
// `w.$transaction` is the same call through `storeWriter` (lib/repo-factory.ts): on Postgres it IS `prisma.$transaction`, so a
// route that moved to the writer must stay visible to this guard (CF-WRITES-1).
const OPENS_TRANSACTION = /(?:prisma|\bw)\.\$transaction\b|\bwithMoneyTx\(/;

/** Files that open a transaction at all. */
function callers(): string[] {
  return sourceFiles(API_SRC).filter(f => OPENS_TRANSACTION.test(code(f)));
}

/**
 * #1791: a whole-FILE `src.includes('hasTenantContext')` cleared EVERY
 * `prisma.$transaction` call in that file the moment the string appeared
 * anywhere — a comment, an unrelated function, a different branch entirely —
 * reproducing the exact defect (cart.service.ts) this registry exists to
 * catch. This checks PER OCCURRENCE instead: a `hasTenantContext` mention has
 * to appear near the specific `$transaction` call, not merely somewhere in
 * the file. Line-proximity, not AST — same "weak evidence about behaviour"
 * caveat as the rest of this file; the behavioural gates are the integration
 * tests named in the header comment. `cart.service.ts`'s real shape (guard
 * check, then the `$transaction` call ~30 lines later inside the branch that
 * runs only when `hasTenantContext()` is false) sits comfortably inside this
 * window; a `hasTenantContext()` in a distant, unrelated function does not.
 */
const OCCURRENCE_PROXIMITY_LINES = 50;

/** Transaction openings in `file` with no nearby `hasTenantContext`. */
function unguardedTransactionLines(file: string): number[] {
  const lines = code(file).split('\n');
  const unguarded: number[] = [];
  lines.forEach((line, i) => {
    if (!OPENS_TRANSACTION.test(line)) return;
    const start = Math.max(0, i - OCCURRENCE_PROXIMITY_LINES);
    const end = Math.min(lines.length, i + OCCURRENCE_PROXIMITY_LINES + 1);
    const nearby = lines.slice(start, end).join('\n');
    if (!nearby.includes('hasTenantContext')) unguarded.push(i + 1); // 1-based for the error message
  });
  return unguarded;
}

describe('nested-transaction registry', () => {
  it('accounts for every service that opens its own transaction', () => {
    const unaccounted = callers().filter(f => {
      if (f in REVIEWED_OWN_TRANSACTION) return false;
      if (UNREVIEWED_PREDATING_THIS_REGISTRY.has(f)) return false;
      return unguardedTransactionLines(f).length > 0;
    });

    expect(
      unaccounted,
      'these services open `prisma.$transaction` on a request path without a `hasTenantContext()` branch and without an entry in this registry. Inside the ambient tenant transaction that runs on a DIFFERENT connection and cannot see rows this request has already written — the P2003 that 500s the first cart write of a session. Either add the branch, or add the file here with the reason it does not need one.'
    ).toEqual([]);
  });

  it('keeps the unreviewed list from growing', () => {
    // The list is a debt ledger. It may shrink; it may not grow. A new entry
    // means someone met the question and wrote "later" instead of answering.
    // main's 11 minus blog.service.ts (a comment, not a call) plus the files
    // the widened scan surfaced (#1787).
    expect(UNREVIEWED_PREDATING_THIS_REGISTRY.size).toBeLessThanOrEqual(24);
  });

  it('does not list a file that has since been fixed', () => {
    // Keeps the ledger honest in the other direction: a service that grew a
    // `hasTenantContext()` branch must come OFF the list, or the count stops
    // meaning anything.
    const opening = new Set(callers());
    const stale = [...UNREVIEWED_PREDATING_THIS_REGISTRY].filter(f => {
      const abs = path.join(API_SRC, f);
      if (!fs.existsSync(abs)) return true;
      if (!opening.has(f)) return true;
      return unguardedTransactionLines(f).length === 0;
    });

    expect(stale, 'these are listed as unreviewed but no longer qualify').toEqual([]);
  });

  it('cart.service.ts is NOT on the list — it is the one that is fixed', () => {
    // The positive control. If the registry were vacuous (a bad glob, an empty
    // `callers()`), this would fail too.
    expect(callers()).toContain('services/cart.service.ts');
    expect(UNREVIEWED_PREDATING_THIS_REGISTRY.has('services/cart.service.ts')).toBe(false);
    expect(fs.readFileSync(path.join(API_SRC, 'services/cart.service.ts'), 'utf-8')).toContain(
      'hasTenantContext'
    );
  });

  it('sees beyond services/ — route handlers and withMoneyTx callers are in scope (#1787)', () => {
    // The scan used to be rooted at services/, so all four route-level sites
    // and every withMoneyTx caller read as clean while never being looked at.
    const found = callers();
    expect(found).toContain('routes/order.routes.ts');
    expect(found).toContain('lib/inngest/functions/order-refunded.ts');
    expect(found).toContain('services/order.service.ts');
    // A file that only mentions the call in a comment is not a caller.
    expect(found).not.toContain('routes/bundle.routes.ts');
  });

  it('every reviewed entry is a real caller with a written reason', () => {
    const opening = new Set(callers());
    for (const [file, reason] of Object.entries(REVIEWED_OWN_TRANSACTION)) {
      expect(opening.has(file), `${file} no longer opens a transaction`).toBe(true);
      expect(reason.length, `${file} needs a reason`).toBeGreaterThan(20);
    }
  });
});
