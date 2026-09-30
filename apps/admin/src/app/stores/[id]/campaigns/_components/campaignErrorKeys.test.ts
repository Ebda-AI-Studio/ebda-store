import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';
import en from '@/i18n/messages/en.json';
import ar from '@/i18n/messages/ar.json';
import { CAMPAIGN_ERROR_KEYS } from './campaignErrorKeys';

const ROUTES = resolve(__dirname, '../../../../../../../api/src/routes/campaign.routes.ts');
// Codes deliberately left on the raw message: NOT_FOUND is a generic 404 the
// editor turns into its own load-failed state.
const NOT_EDITOR_FACING = new Set(['NOT_FOUND']);

describe('campaign editor translates every refusal the routes can return (issue 2082)', () => {
  const source = readFileSync(ROUTES, 'utf8');
  const thrown = new Set(
    [...source.matchAll(/AppError\(\s*4\d\d\s*,\s*'([A-Z_]+)'/g)].map(m => m[1])
  );

  it('reads a non-trivial set of codes from the route (control)', () => {
    expect(thrown.has('CAMPAIGN_HAS_SEND_HISTORY')).toBe(true);
    expect(thrown.size).toBeGreaterThan(5);
  });

  it('every thrown 4xx code has a translation key', () => {
    const missing = [...thrown].filter(c => !NOT_EDITOR_FACING.has(c) && !CAMPAIGN_ERROR_KEYS[c]);
    expect(missing).toEqual([]);
  });

  it('every mapped key exists in both locales', () => {
    const errs = [
      (en as unknown as { campaigns: { errors: Record<string, string> } }).campaigns.errors,
      (ar as unknown as { campaigns: { errors: Record<string, string> } }).campaigns.errors,
    ];
    for (const key of new Set(Object.values(CAMPAIGN_ERROR_KEYS)))
      for (const e of errs) expect(e[key], key).toBeTruthy();
  });
});
