import { describe, it, expect } from 'vitest';
import { FEATURE_REGISTRY } from '@ebda/shared';
import {
  ROUTE_FEATURE_GATES,
  featureForStorePath,
  isPlanGateError,
  PLAN_GATE_FALLBACK,
} from '../../apps/admin/src/lib/route-feature-gates';

describe('featureForStorePath (audit G-3: entitlements read once in the layout)', () => {
  it.each([
    ['/stores/s1/stock/purchase-orders', 'inventory.purchase_orders'],
    ['/stores/s1/stock/purchase-orders/new', 'inventory.purchase_orders'],
    ['/stores/s1/stock/backorders', 'inventory.backorder'],
    ['/stores/s1/stock/warehouses/w9', 'inventory.multi_warehouse'],
    ['/stores/s1/stock/adjustments', 'inventory.bulk_adjustments'],
    ['/stores/s1/stock/suppliers', 'accounting.basic'],
    ['/stores/s1/finance/dashboard', 'accounting.basic'],
    ['/stores/s1/finance/journal/e1', 'accounting.basic'],
    ['/stores/s1/finance/expenses', 'accounting.expenses'],
    ['/stores/s1/finance/bank-reconciliation/import', 'accounting.bank_reconcile'],
    ['/stores/s1/campaigns', 'email_campaigns'],
    ['/stores/s1/loyalty/transactions', 'loyalty'],
    ['/stores/s1/staff', 'staff_accounts'],
  ])('%s -> %s', (path, key) => {
    expect(featureForStorePath(path, 's1')).toBe(key);
  });

  it.each([
    '/stores/s1',
    '/stores/s1/products',
    '/stores/s1/stock/inventory',
    '/stores/s1/stock/dashboard',
    '/stores/s2/finance/journal',
    '/login',
  ])('%s is not gated by the layout', path => {
    expect(featureForStorePath(path, 's1')).toBeNull();
  });

  it('does not match a path that merely starts with the same letters', () => {
    expect(featureForStorePath('/stores/s1/staffing', 's1')).toBeNull();
  });

  it('every gated feature key exists in the shared registry', () => {
    for (const g of ROUTE_FEATURE_GATES)
      expect(FEATURE_REGISTRY[g.feature as keyof typeof FEATURE_REGISTRY], g.feature).toBeDefined();
  });
});

describe('isPlanGateError', () => {
  it('402 is a plan gate', () => expect(isPlanGateError({ status: 402 })).toBe(true));
  it('403 FEATURE_DISABLED is a plan gate', () =>
    expect(isPlanGateError({ status: 403, code: 'FEATURE_DISABLED' })).toBe(true));
  it('a bare 403 (no code) is treated as a plan gate, never shown raw', () =>
    expect(isPlanGateError({ status: 403, code: 'SERVER_ERROR' })).toBe(true));
  it('a 403 with a real permission code is NOT a plan gate', () =>
    expect(isPlanGateError({ status: 403, code: 'FORBIDDEN' })).toBe(false));
  it('MFA setup is not a plan gate', () =>
    expect(isPlanGateError({ status: 403, code: 'MFA_SETUP_REQUIRED' })).toBe(false));
  it('other statuses / null are not', () => {
    expect(isPlanGateError({ status: 500 })).toBe(false);
    expect(isPlanGateError(null)).toBe(false);
  });
});

describe('PLAN_GATE_FALLBACK copy', () => {
  it('has Arabic (Egyptian) and English sentences, never the raw API text', () => {
    for (const l of ['ar', 'en'] as const) {
      expect(PLAN_GATE_FALLBACK[l]).toBeTruthy();
      expect(PLAN_GATE_FALLBACK[l]).not.toMatch(/Request failed|Feature not available/);
    }
  });
});

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

describe('no admin page renders the raw plan-gate text (audit G-2)', () => {
  const src = join(__dirname, '../../apps/admin/src');
  const walk = (d: string, out: string[] = []): string[] => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.tsx?$/.test(e) && !/\.test\./.test(e)) out.push(p);
    }
    return out;
  };
  it('the raw strings exist only in the API client + the gate map that normalises them', () => {
    const offenders = walk(src)
      .filter(f => /Request failed with status|Feature not available/.test(readFileSync(f, 'utf8')))
      .map(f => f.slice(src.length + 1))
      .filter(f => f !== 'lib/api.ts' && f !== 'lib/route-feature-gates.ts');
    expect(offenders).toEqual([]);
  });

  it('every plan-gated page family from the audit is in the map', () => {
    const covered = (p: string) => featureForStorePath(`/stores/s1${p}`, 's1') !== null;
    for (const p of [
      '/stock/purchase-orders',
      '/stock/backorders',
      '/stock/warehouses',
      '/stock/adjustments',
      '/stock/suppliers',
      '/finance/accounts',
      '/finance/journal',
      '/finance/expenses',
      '/finance/reports',
      '/finance/bank-reconciliation',
      '/campaigns',
      '/abandoned-carts',
      '/affiliates',
      '/loyalty',
      '/bundles',
      '/staff',
      '/answer-engine',
    ])
      expect(covered(p), p).toBe(true);
  });
});
