/**
 * Ruling NZ-PG-4: tenant isolation of the `access`, `platform`, `payments` and `ops` D1 tables is code-level (there is no RLS and no
 * tenant guard on D1). This is the static scan that keeps it true: every query on a TENANT table of those families must name
 * the tenant (store / owner / user) in its filter, or sit in the exemption list below WITH its reason.
 *
 *  - raw SQL: every string literal under apps/api/src that reads or writes a tenant table;
 *  - model calls: every `<client>.<model>.<op>(...)` on a tenant model (the router answers them from D1 after the marker).
 *
 * Platform-wide tables (no tenant column by design: legal_notice_*, provider_verification*, ci_insights, answer_engine_provider_configs,
 * system_settings) are not scanned; the ruling lists them. A scan that stops finding statements fails (a broken regex must not read as green).
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '../../apps/api/src');

const TENANT_TABLES = [
  'store_staff',
  'staff_invites',
  'store_features',
  'legal_acceptances',
  'merchant_api_keys',
  'slug_redirects',
  'provider_activation_requests',
  'instapay_receipts',
  'manual_payment_claims',
  'instapay_auto_confirmations',
  'store_usage_snapshots',
  'onesignal_subscriptions',
];
const TENANT_MODELS = [
  'storeStaff',
  'staffInvite',
  'storeFeature',
  'legalAcceptance',
  'merchantApiKey',
  'slugRedirect',
  'providerActivationRequest',
  'instapayReceipt',
  'manualPaymentClaim',
  'instapayAutoConfirmation',
  'storeUsageSnapshot',
  'oneSignalSubscription',
];

/** A filter that names the tenant: a store, its owner, or the account that owns the row. */
const SQL_TENANT = /store_id|owner_id|user_id|sent_by|invited_by|accepted_by|email/i;
const CALL_TENANT = /storeId|ownerId|userId|store_id|claimId|email/;

/**
 * `<file>::<model>.<op>` -> why this call may span tenants. Every entry is a super_admin / cron cross-store read behind its
 * route's role gate, or a call whose filter is built into a variable that carries the store (checked by hand, named here).
 */
const EXEMPT_CALLS: Record<string, string> = {
  'routes/admin.routes.ts::storeUsageSnapshot.groupBy':
    'super_admin usage report: periods across stores (the per-store rows are read with storeFilter in the same handler)',
  'routes/admin.routes.ts::storeUsageSnapshot.findMany':
    'super_admin usage report, behind requireRole(super_admin); storeFilter when one store is asked for',
  'services/slug-redirect.service.ts::slugRedirect.findMany':
    "where is built from the caller's storeId (slugRedirectDb(storeId))",
  'services/slug-redirect.service.ts::slugRedirect.count':
    "same `where` as the list above: built from the caller's storeId",
  'services/billing/account.service.ts::manualPaymentClaim.findMany':
    "super_admin claim queue (oldest 200 by status), reached only from the payments-confirm route's role gate",
  'services/billing/instapay-auto-confirm.service.ts::instapayAutoConfirmation.findUnique':
    'idempotency-key lookups inside withStore(storeId, ...): the key embeds the receipt id, which belongs to that store (the store scope is the filter on D1 and RLS on Postgres)',
  'services/billing/instapay-auto-confirm.service.ts::instapayAutoConfirmation.findMany':
    'listAutoConfirmationsForAdmin: super_admin queue across stores, behind requireRole(super_admin)',
  'services/legal-notice.service.ts::legalAcceptance.count':
    'super_admin legal-notice progress: acceptances of one document version across stores (platform-wide count, no row leaves)',
  'services/onesignal.service.ts::oneSignalSubscription.findMany':
    "the shared `q` is { where: { userId } } (the caller's own devices), built one line above",
  'services/payment-providers/instapay-receipt.service.ts::instapayReceipt.findMany':
    'the shared `scope` is built with { storeId, ... } one statement above',
  'services/payment-providers/instapay-receipt.service.ts::instapayReceipt.updateMany':
    'the shared `scope` is built with { storeId, ... } one statement above',
  'services/merchant-signup.service.ts::legalAcceptance.createMany':
    'insert of the new merchant profile acceptances (profileId is the owner key of the rows)',
};

const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : walk(p);
    return e.name.endsWith('.ts') && !e.name.includes('.test.') ? [p] : [];
  });
const files = walk(SRC);
const rel = (p: string) => path.relative(SRC, p).split(path.sep).join('/');

function balanced(s: string, open: number): string {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')' && --depth === 0) return s.slice(open, i + 1);
  }
  return s.slice(open);
}

const LITERAL = /`(?:[^`\\]|\\.)*`|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g;
const TABLE_REF = new RegExp(
  `(?:FROM|UPDATE|INTO|JOIN)\\s+"?(${TENANT_TABLES.join('|')})"?\\b`,
  'i'
);
const CALL = new RegExp(
  `\\b\\w+\\s*\\.\\s*(${TENANT_MODELS.join('|')})\\s*\\.\\s*(findMany|findFirst|findUnique|findFirstOrThrow|findUniqueOrThrow|count|update|updateMany|delete|deleteMany|upsert|aggregate|groupBy|create|createMany)\\s*(?:<[^>(]*>)?\\(`,
  'g'
);

describe('NZ-PG-4: D1 queries on tenant tables name the tenant', () => {
  it('raw SQL on a tenant table filters by store / owner / user', () => {
    let scanned = 0;
    const bad: string[] = [];
    for (const f of files) {
      const s = fs.readFileSync(f, 'utf8');
      for (const m of s.matchAll(LITERAL)) {
        const lit = m[0];
        if (lit.length < 20 || !TABLE_REF.test(lit)) continue;
        // a Postgres statement ($1 placeholders) belongs to the pre-cutover branch, not to D1
        if (/\$\d/.test(lit)) continue;
        scanned++;
        if (!SQL_TENANT.test(lit)) bad.push(`${rel(f)}: ${lit.replace(/\s+/g, ' ').slice(0, 120)}`);
      }
    }
    expect(scanned, 'the scan found the D1 statements').toBeGreaterThanOrEqual(12);
    expect(bad, 'D1 SQL on a tenant table without a store / owner / user filter').toEqual([]);
  });

  it('model calls on a tenant model name the tenant or are exempt with a reason', () => {
    let scanned = 0;
    const bad: string[] = [];
    const seenExempt = new Set<string>();
    for (const f of files) {
      const s = fs.readFileSync(f, 'utf8');
      for (const m of s.matchAll(CALL)) {
        scanned++;
        const args = balanced(s, m.index! + m[0].length - 1);
        if (CALL_TENANT.test(args)) continue;
        const key = `${rel(f)}::${m[1]}.${m[2]}`;
        if (key in EXEMPT_CALLS) seenExempt.add(key);
        else bad.push(`${key} ${args.replace(/\s+/g, ' ').slice(0, 90)}`);
      }
    }
    expect(scanned, 'the scan found the model calls').toBeGreaterThanOrEqual(80);
    expect(bad, 'a tenant-model call with no store / owner / user in its filter').toEqual([]);
    expect(
      Object.keys(EXEMPT_CALLS).filter(k => !seenExempt.has(k)),
      'stale exemption (the call now names its tenant or is gone): delete it'
    ).toEqual([]);
  });

  it('the scan catches a violation (negative control)', () => {
    const src = 'await tx.storeStaff.findMany({ where: { role: "x" } });';
    const m = [...src.matchAll(CALL)][0]!;
    expect(CALL_TENANT.test(balanced(src, m.index! + m[0].length - 1))).toBe(false);
    expect(TABLE_REF.test('`SELECT * FROM store_staff WHERE id = ?1`')).toBe(true);
    expect(SQL_TENANT.test('SELECT * FROM store_staff WHERE id = ?1')).toBe(false);
  });
});
