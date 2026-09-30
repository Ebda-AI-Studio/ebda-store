/**
 * Regression for #1709: carrierConfigSchema's baseUrl refinement ran
 * `new URL(baseUrl)` on the raw incoming value with no mask-sentinel check
 * before preserveMaskedCredentials' merge. An unchanged field resubmits the
 * `****` mask maskCredentials() emitted — validating THAT as a URL throws,
 * 400ing a save where the merchant made no baseUrl edit at all.
 */
import { describe, it, expect } from 'vitest';
import { carrierConfigSchema } from '@api/routes/shipping-carrier.routes';

describe('carrierConfigSchema baseUrl validation (#1709)', () => {
  it('accepts a masked (unchanged) baseUrl value', () => {
    const result = carrierConfigSchema.safeParse({
      enabled: true,
      credentials: { baseUrl: '****', apiKey: 'abcd1234' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts a partially-masked baseUrl value (prefix + ****)', () => {
    const result = carrierConfigSchema.safeParse({
      enabled: true,
      credentials: { baseUrl: 'http****', apiKey: 'abcd1234' },
    });
    expect(result.success).toBe(true);
  });

  it('still rejects a genuinely invalid (unmasked) baseUrl', () => {
    const result = carrierConfigSchema.safeParse({
      enabled: true,
      credentials: { baseUrl: 'not a url', apiKey: 'abcd1234' },
    });
    expect(result.success).toBe(false);
  });

  it('still accepts a genuinely valid baseUrl', () => {
    const result = carrierConfigSchema.safeParse({
      enabled: true,
      credentials: { baseUrl: 'https://api.icarry.co', apiKey: 'abcd1234' },
    });
    expect(result.success).toBe(true);
  });
});
