/**
 * Phase 0 StoreDO flag (Ruling INFRA-CF-1): the SQLite store may serve a request only for a store listed in
 * STORE_DO_ENABLED_IDS that also opts in with `x-ebda-backend: do`. Default, unknown store, missing header and
 * a malformed list must all stay on Postgres; the QA walk store must never be flaggable by accident.
 */
import { describe, it, expect } from 'vitest';
import { backendFor, enabledStoreIds } from '../../apps/api/src/lib/store-backend';

const req = (h: Record<string, string> = {}) => ({ headers: h });
const DEMO = '09b5dbd1-1774-49b5-b781-e06d0ee7b0fe';

describe('store backend flag', () => {
  it('is empty (nobody) by default', () => {
    expect(enabledStoreIds(undefined).size).toBe(0);
    expect(enabledStoreIds('').size).toBe(0);
    expect(enabledStoreIds(' , ,').size).toBe(0);
  });

  it('serves from the DO only when the id is listed AND the request opts in', () => {
    process.env.STORE_DO_ENABLED_IDS = ` ${DEMO} , other `;
    try {
      expect(backendFor(DEMO, req({ 'x-ebda-backend': 'do' }))).toBe('do');
      expect(backendFor(DEMO, req())).toBe('pg'); // listed but no opt-in
      expect(backendFor(DEMO, req({ 'x-ebda-backend': 'pg' }))).toBe('pg');
      expect(backendFor('not-listed', req({ 'x-ebda-backend': 'do' }))).toBe('pg'); // opt-in alone is not enough
    } finally {
      delete process.env.STORE_DO_ENABLED_IDS;
    }
  });

  it('unset flag keeps even an opted-in request on Postgres', () => {
    delete process.env.STORE_DO_ENABLED_IDS;
    expect(backendFor(DEMO, req({ 'x-ebda-backend': 'do' }))).toBe('pg');
  });

  it('the committed wrangler flag is empty (never ships a store id by accident outside a ruling)', async () => {
    const { readFileSync } = await import('node:fs');
    const w = readFileSync('apps/api/wrangler.jsonc', 'utf8');
    const m = w.match(/"STORE_DO_ENABLED_IDS":\s*"([^"]*)"/);
    expect(m).not.toBeNull();
    expect(m![1]).not.toMatch(/qa-walk/);
  });
});
