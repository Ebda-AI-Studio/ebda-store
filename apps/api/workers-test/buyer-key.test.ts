import { describe, expect, it } from 'vitest';
// Only the pure module: the package index pulls zod schemas the test worker does not need.
import { buyerKeyFor } from '../../../packages/shared/src/buyer-key';

/** The contract's pinned vector, on the real workerd WebCrypto (the same number the WhatsApp repo pins). */
describe('buyerKey on workerd', () => {
  it('matches the contract vector for every spelling of the phone', async () => {
    const vector = 'e8771d4105457e95d06a8589827d6c09043f73bb1750f2ef525bccbc22d67edd';
    for (const raw of [
      '+201001234567',
      '01001234567',
      '201001234567',
      '+20 100 123 4567',
      '٠١٠٠١٢٣٤٥٦٧',
    ]) {
      expect(await buyerKeyFor('ebda-suite-buyer-key-test-v1', raw)).toBe(vector);
    }
  });
});
