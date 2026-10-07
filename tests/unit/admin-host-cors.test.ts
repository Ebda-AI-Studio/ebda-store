import { describe, expect, it } from 'vitest';
import { isPlatformOrigin } from '../../apps/api/src/lib/cors-cache';

// Ruling EBDA-HOST-1: the merchant admin host is admin.ebda.app. app.ebda.app
// was never live and is not an allowed origin.
describe('platform origins after the admin host move', () => {
  const env = { nodeEnv: 'production' };
  it('accepts admin.ebda.app with no env var set (BRAND fallback)', () => {
    expect(isPlatformOrigin('https://admin.ebda.app', env)).toBe(true);
  });
  it('rejects the retired app.ebda.app', () => {
    expect(isPlatformOrigin('https://app.ebda.app', env)).toBe(false);
  });
});
