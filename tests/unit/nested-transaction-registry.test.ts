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

const SERVICES = path.resolve(__dirname, '../../apps/api/src/services');

/**
 * Call sites reviewed and left on their own transaction, with why.
 *
 * A file is listed here ONLY when someone has read it and established that it
 * does not write-then-reference within one request. "I did not look" is not a
 * reason — use the unreviewed list below for that, which is deliberately
 * uncomfortable to leave entries in.
 */
const REVIEWED_OWN_TRANSACTION: Record<string, string> = {};

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
  'affiliate.service.ts',
  'auth.service.ts',
  'barcode-scan.service.ts',
  'blog.service.ts',
  'bulk.service.ts',
  'customer-group.service.ts',
  'inventory.service.ts',
  'loyalty-automation.service.ts',
  'loyalty.service.ts',
  'payment-confirm.service.ts',
  'payment-providers/payment.factory.ts',
  'shipping-carrier.service.ts',
  'shipping.service.ts',
]);

function serviceFiles(dir: string, rel = ''): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const next = path.join(dir, e.name);
    const relName = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) return serviceFiles(next, relName);
    return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [relName] : [];
  });
}

/** Files that call `prisma.$transaction` at all. */
function callers(): string[] {
  return serviceFiles(SERVICES).filter(f =>
    fs.readFileSync(path.join(SERVICES, f), 'utf-8').includes('prisma.$transaction')
  );
}

describe('nested-transaction registry', () => {
  it('accounts for every service that opens its own transaction', () => {
    const unaccounted = callers().filter(f => {
      const src = fs.readFileSync(path.join(SERVICES, f), 'utf-8');
      if (src.includes('hasTenantContext')) return false;
      if (f in REVIEWED_OWN_TRANSACTION) return false;
      return !UNREVIEWED_PREDATING_THIS_REGISTRY.has(f);
    });

    expect(
      unaccounted,
      'these services open `prisma.$transaction` on a request path without a `hasTenantContext()` branch and without an entry in this registry. Inside the ambient tenant transaction that runs on a DIFFERENT connection and cannot see rows this request has already written — the P2003 that 500s the first cart write of a session. Either add the branch, or add the file here with the reason it does not need one.'
    ).toEqual([]);
  });

  it('keeps the unreviewed list from growing', () => {
    // The list is a debt ledger. It may shrink; it may not grow. A new entry
    // means someone met the question and wrote "later" instead of answering.
    expect(UNREVIEWED_PREDATING_THIS_REGISTRY.size).toBeLessThanOrEqual(13);
  });

  it('does not list a file that has since been fixed', () => {
    // Keeps the ledger honest in the other direction: a service that grew a
    // `hasTenantContext()` branch must come OFF the list, or the count stops
    // meaning anything.
    const stale = [...UNREVIEWED_PREDATING_THIS_REGISTRY].filter(f => {
      const abs = path.join(SERVICES, f);
      if (!fs.existsSync(abs)) return true;
      return fs.readFileSync(abs, 'utf-8').includes('hasTenantContext');
    });

    expect(stale, 'these are listed as unreviewed but no longer qualify').toEqual([]);
  });

  it('cart.service.ts is NOT on the list — it is the one that is fixed', () => {
    // The positive control. If the registry were vacuous (a bad glob, an empty
    // `callers()`), this would fail too.
    expect(callers()).toContain('cart.service.ts');
    expect(UNREVIEWED_PREDATING_THIS_REGISTRY.has('cart.service.ts')).toBe(false);
    expect(fs.readFileSync(path.join(SERVICES, 'cart.service.ts'), 'utf-8')).toContain(
      'hasTenantContext'
    );
  });
});
