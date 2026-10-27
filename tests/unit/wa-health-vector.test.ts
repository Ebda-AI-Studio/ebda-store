/**
 * WA-HEALTH-VECTOR-1: GET /health proves both Workers hold the same SUITE_BUYER_KEY_SECRET without sending
 * it, and never carries anything phone-derived.
 */
import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { BUYER_KEY_PROBE_MESSAGE, buyerKeyVector } from '@api/lib/wa/health-vector';
import { healthPayload } from '@api/lib/health-payload';
import { buyerKeyFor } from '@ebda/shared';

const SECRET = 'ebda-suite-buyer-key-test-v1-padded-to-32-chars';

describe('buyerKeyVector', () => {
  it('is the first 16 hex chars of HMAC-SHA256(secret as UTF-8, "suite-buyer-key-probe:v1")', async () => {
    expect(BUYER_KEY_PROBE_MESSAGE).toBe('suite-buyer-key-probe:v1');
    // independent implementation (node:crypto) and a pinned literal
    const expected = createHmac('sha256', Buffer.from(SECRET, 'utf8'))
      .update('suite-buyer-key-probe:v1', 'utf8')
      .digest('hex')
      .slice(0, 16);
    expect(await buyerKeyVector(SECRET)).toBe(expected);
    expect(expected).toBe('78aa2a0d36ad87d0');
  });

  it('is null (the field is omitted, never a placeholder) when the secret is unset or empty', async () => {
    expect(await buyerKeyVector(undefined)).toBeNull();
    expect(await buyerKeyVector('')).toBeNull();
  });

  it('differs for a different secret (a mismatch between the two Workers is visible)', async () => {
    expect(await buyerKeyVector(`${SECRET}x`)).not.toBe(await buyerKeyVector(SECRET));
  });
});

describe('GET /health payload', () => {
  const ALLOWED = new Set(['status', 'timestamp', 'commit', 'deploymentId', 'buyerKeyVector']);

  it('adds buyerKeyVector when the secret is set, and only the known fields', async () => {
    const body = await healthPayload({ SUITE_BUYER_KEY_SECRET: SECRET } as never);
    expect(body.buyerKeyVector).toBe('78aa2a0d36ad87d0');
    expect(Object.keys(body).filter(k => !ALLOWED.has(k))).toEqual([]);
  });

  it('omits buyerKeyVector without the secret', async () => {
    const body = await healthPayload({} as never);
    expect('buyerKeyVector' in body).toBe(false);
  });

  it('nothing phone-derived appears in /health: no buyer key, no E.164, no long digit run', async () => {
    const body = await healthPayload({ SUITE_BUYER_KEY_SECRET: SECRET } as never);
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/[0-9a-f]{64}/); // a buyer key is 64 hex
    expect(text).not.toMatch(/\+\d{8,}/);
    expect(text).not.toMatch(/\d{10,}/);
    // and the vector is not a prefix of any phone's buyer key
    for (const phone of ['01001234567', '+201001234567', '01112345678']) {
      const key = (await buyerKeyFor(SECRET, phone))!;
      expect(key.startsWith(body.buyerKeyVector as string)).toBe(false);
    }
  });
});
