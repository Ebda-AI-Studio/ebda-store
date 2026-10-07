import { describe, expect, it } from 'vitest';
import { isPlatformOrigin } from '../../apps/api/src/lib/cors-cache';

// Ruling HOST-STORE-1: the Ebda Store merchant app is store.ebda.app. admin.ebda.app
// is RETIRED (no redirect) and app.ebda.app was never live: neither is an allowed origin.
describe('platform origins after the store host move', () => {
  const env = { nodeEnv: 'production' };
  it('accepts store.ebda.app with no env var set (BRAND fallback)', () => {
    expect(isPlatformOrigin('https://store.ebda.app', env)).toBe(true);
  });
  it('rejects the retired admin.ebda.app', () => {
    expect(isPlatformOrigin('https://admin.ebda.app', env)).toBe(false);
  });
  it('rejects the never-live app.ebda.app', () => {
    expect(isPlatformOrigin('https://app.ebda.app', env)).toBe(false);
  });
});
