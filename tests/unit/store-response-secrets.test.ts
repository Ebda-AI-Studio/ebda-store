/**
 * STORE-RESP-SECRETS-1: no API response may echo a raw Store row. Every
 * store-returning response goes through toSafeStoreResponse (masks the Meta
 * CAPI / TikTok Events tokens in marketingPixels).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { toSafeStoreResponse } from '../../apps/api/src/lib/store-response';

const ROUTES = join(__dirname, '../../apps/api/src/routes');
const RAW_STORE = /data:\s*(\{\s*store\s*[,}]|store\s*[,}\n])/;

describe('toSafeStoreResponse', () => {
  const token = 'EAABsecretCAPItokenwXyz1234';
  const store = {
    id: 's1',
    marketingPixels: {
      meta: { pixelId: '123', accessToken: token },
      tiktok: { accessToken: token },
    },
  };

  it('masks every pixel access token and keeps public ids', () => {
    const out = toSafeStoreResponse(store);
    expect(JSON.stringify(out)).not.toContain(token);
    expect(out.marketingPixels).toMatchObject({ meta: { pixelId: '123' } });
  });

  it('does not mutate the input and passes through null / rows without pixels', () => {
    toSafeStoreResponse(store);
    expect(store.marketingPixels.meta.accessToken).toBe(token);
    expect(toSafeStoreResponse(null)).toBeNull();
    expect(toSafeStoreResponse({ id: 'x' })).toEqual({ id: 'x' });
  });
});

describe('route guard: no raw store in a response', () => {
  const files = readdirSync(ROUTES).filter(f => f.endsWith('.ts'));
  it.each(files)('%s returns no unserialized store', file => {
    const offenders = readFileSync(join(ROUTES, file), 'utf8')
      .split('\n')
      .map((l, i) => ({ l, n: i + 1 }))
      .filter(({ l }) => RAW_STORE.test(l));
    expect(offenders).toEqual([]);
  });
});
