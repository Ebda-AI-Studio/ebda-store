/**
 * WA-HEALTH-VECTOR-1: GET /health proves both Workers hold the same SUITE_BUYER_KEY_SECRET without sending
 * it, never carries anything phone-derived, and is emitted only for a strong (>= 64 char) secret.
 * The vector comes from the shared file Ebda Chat vendors too (tests/vectors/ebda-wa/buyer-key-probe.json).
 */
import { describe, expect, it } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  BUYER_KEY_PROBE_MESSAGE,
  MIN_PROBE_SECRET_LENGTH,
  buyerKeyVector,
} from '@api/lib/wa/health-vector';
import { healthPayload } from '@api/lib/health-payload';
import { buyerKeyFor } from '@ebda/shared';

const DIR = path.resolve(__dirname, '../vectors/ebda-wa');
const FILE = path.join(DIR, 'buyer-key-probe.json');
const probe = JSON.parse(readFileSync(FILE, 'utf8')) as {
  secret: string;
  message: string;
  vector: string;
};
const SECRET = probe.secret;
const SHORT = 'ebda-suite-buyer-key-test-v1-padded-to-32-chars'; // valid for buyer keys, too short for the probe

describe('the shared probe vector file', () => {
  it('is pinned in SHA256SUMS (a one-sided edit fails here and in the WhatsApp repo)', () => {
    const sums = Object.fromEntries(
      readFileSync(path.join(DIR, 'SHA256SUMS'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(l => {
          const [h, f] = l.trim().split(/\s+/);
          return [f, h];
        })
    );
    expect(sums['buyer-key-probe.json']).toBe(
      createHash('sha256').update(readFileSync(FILE)).digest('hex')
    );
  });

  it('uses the public probe message and a secret that is long enough to be emitted', () => {
    expect(probe.message).toBe(BUYER_KEY_PROBE_MESSAGE);
    expect(probe.message).toBe('suite-buyer-key-probe:v1');
    expect(probe.secret.length).toBeGreaterThanOrEqual(MIN_PROBE_SECRET_LENGTH);
    expect(probe.vector).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('buyerKeyVector', () => {
  it('is the first 16 hex chars of HMAC-SHA256(secret as UTF-8, probe message): the file vector', async () => {
    const independent = createHmac('sha256', Buffer.from(SECRET, 'utf8'))
      .update(probe.message, 'utf8')
      .digest('hex')
      .slice(0, 16);
    expect(independent).toBe(probe.vector);
    expect(await buyerKeyVector(SECRET)).toBe(probe.vector);
  });

  it('is null (the field is omitted, never a placeholder) when the secret is unset or empty', async () => {
    expect(await buyerKeyVector(undefined)).toBeNull();
    expect(await buyerKeyVector('')).toBeNull();
  });

  it('GUARD: a secret shorter than 64 chars is never probed (offline guessing oracle)', async () => {
    expect(MIN_PROBE_SECRET_LENGTH).toBe(64);
    expect(await buyerKeyVector(SHORT)).toBeNull();
    expect(await buyerKeyVector('x'.repeat(63))).toBeNull();
    expect(await buyerKeyVector('x'.repeat(64))).toMatch(/^[0-9a-f]{16}$/);
  });

  it('differs for a different secret (a mismatch between the two Workers is visible)', async () => {
    expect(await buyerKeyVector(`${SECRET}x`)).not.toBe(await buyerKeyVector(SECRET));
  });
});

describe('GET /health payload', () => {
  // `postgres` is the constant 'removed' (Ruling NZ-D23): nothing derived from a phone, an order or a customer
  const ALLOWED = new Set([
    'status',
    'timestamp',
    'commit',
    'deploymentId',
    'buyerKeyVector',
    'postgres',
    // INSTAPAY-AUTO-1: readiness by NAME only (never a value, never phone-derived)
    'instapayAuto',
  ]);

  it('adds buyerKeyVector for a strong secret, and only the known fields', async () => {
    const body = await healthPayload({ SUITE_BUYER_KEY_SECRET: SECRET } as never);
    expect(body.buyerKeyVector).toBe(probe.vector);
    expect(Object.keys(body).filter(k => !ALLOWED.has(k))).toEqual([]);
  });

  it('omits buyerKeyVector without the secret or with a short one', async () => {
    expect('buyerKeyVector' in (await healthPayload({} as never))).toBe(false);
    expect(
      'buyerKeyVector' in (await healthPayload({ SUITE_BUYER_KEY_SECRET: SHORT } as never))
    ).toBe(false);
  });

  it('nothing phone-derived appears in /health: no buyer key, no E.164, no long digit run', async () => {
    const body = await healthPayload({ SUITE_BUYER_KEY_SECRET: SECRET } as never);
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/[0-9a-f]{64}/); // a buyer key is 64 hex
    expect(text).not.toMatch(/\+\d{8,}/);
    expect(text).not.toMatch(/\d{10,}/);
    for (const phone of ['01001234567', '+201001234567', '01112345678']) {
      const key = (await buyerKeyFor(SECRET, phone))!;
      expect(key.startsWith(body.buyerKeyVector as string)).toBe(false);
    }
  });
});
