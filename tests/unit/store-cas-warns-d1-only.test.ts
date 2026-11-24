/**
 * A field that exists only in D1 is not written by the DO compare-and-set; that skip must be logged (store id, field, job; never
 * values). `storeCompareAndSet` must route the DO's `directoryOnly` answer through `warnD1OnlySkips`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('@api/lib/logger', () => ({
  default: { warn: h.warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { warnD1OnlySkips } from '@api/lib/store-cas-warn';

describe('warnD1OnlySkips', () => {
  beforeEach(() => h.warn.mockClear());

  it('warns once per D1-only field, with store id, field and job but no values', () => {
    warnD1OnlySkips('store-1', ['emailDomain', 'domain'], 'bulk-ai-seo');
    expect(h.warn).toHaveBeenCalledTimes(2);
    const [fields] = h.warn.mock.calls[0];
    expect(fields).toEqual({ storeId: 'store-1', field: 'emailDomain', job: 'bulk-ai-seo' });
  });

  it('is silent when the DO served every field', () => {
    warnD1OnlySkips('store-1', [], 'bulk-ai-seo');
    warnD1OnlySkips('store-1', undefined);
    expect(h.warn).not.toHaveBeenCalled();
  });
});

describe('storeCompareAndSet wiring', () => {
  it('passes the DO directoryOnly list and the job to warnD1OnlySkips', () => {
    const src = readFileSync(join(__dirname, '../../apps/api/src/lib/repo-factory.ts'), 'utf8');
    const body = src.slice(src.indexOf('export async function storeCompareAndSet('));
    expect(body).toContain('warnD1OnlySkips(storeId, directoryOnly, job)');
  });
});
