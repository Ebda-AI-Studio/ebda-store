import { describe, it, expect } from 'vitest';
import { installTestIdentity } from '../../apps/api/src/lib/test-identity';

// The integration identity stand-in must fail closed: it installs only for NODE_ENV=test WITH a test key.
describe('installTestIdentity gate', () => {
  it('does nothing in production, even with a key', () => {
    expect(installTestIdentity({ NODE_ENV: 'production', EBDA_TEST_IDENTITY_JWK: '{}' })).toBe(
      false
    );
  });
  it('does nothing in test without a key', () => {
    expect(installTestIdentity({ NODE_ENV: 'test' })).toBe(false);
  });
  it('does nothing when NODE_ENV is unset', () => {
    expect(installTestIdentity({ EBDA_TEST_IDENTITY_JWK: '{}' })).toBe(false);
  });
});
