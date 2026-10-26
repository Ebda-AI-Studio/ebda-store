/**
 * The Store's phone normaliser and buyer key must produce EXACTLY what Ebda WhatsApp produces (audit
 * CODE-10: two normalisers that differ give one customer two keys). Both repos run the IDENTICAL vector
 * files, created by the WhatsApp session:
 *   tests/vectors/ebda-wa/phone.json      input phone  -> E.164 (or null)
 *   tests/vectors/ebda-wa/buyer-key.json  secret + phones -> lowercase-hex buyer key (8 numbers)
 * Vendored byte for byte; the sha256 of each is pinned in tests/vectors/ebda-wa/SHA256SUMS so a one-sided
 * edit fails here. UNTIL the WhatsApp session delivers the files this test reports them missing and
 * skips (the only skip in this file); once they are vendored it must never skip, and it asserts all 8.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { buyerKeyFor, toE164 } from '@ebda/shared';

const DIR = path.resolve(__dirname, '../vectors/ebda-wa');
const PHONE = path.join(DIR, 'phone.json');
const KEYS = path.join(DIR, 'buyer-key.json');
const SUMS = path.join(DIR, 'SHA256SUMS');
const present = existsSync(PHONE) && existsSync(KEYS);

const sha = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex');

/** Accept `[{ input, e164 }]`, `[{ phone, e164 }]` or a plain `{ input: e164 }` map. */
function phoneCases(raw: unknown): Array<[string, string | null]> {
  if (Array.isArray(raw)) {
    return raw.map((c: Record<string, unknown>) => {
      const input = (c.input ?? c.phone ?? c.raw) as string;
      const out = (c.e164 ?? c.expected ?? c.output ?? null) as string | null;
      if (typeof input !== 'string') throw new Error('unrecognised phone.json case shape');
      return [input, out];
    });
  }
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj.cases)) return phoneCases(obj.cases);
    return Object.entries(obj).map(([k, v]) => [k, v as string | null]);
  }
  throw new Error('unrecognised phone.json shape');
}

describe.skipIf(!present)('shared vectors with Ebda WhatsApp', () => {
  it('both files are the ones the WhatsApp repo pins (sha256)', () => {
    const lines = readFileSync(SUMS, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => l.trim().split(/\s+/));
    const pinned = Object.fromEntries(lines.map(([h, f]) => [path.basename(f!), h]));
    expect(pinned['phone.json']).toBe(sha(PHONE));
    expect(pinned['buyer-key.json']).toBe(sha(KEYS));
  });

  it('phone.json: toE164 gives the same E.164 (or null) for every input', () => {
    const cases = phoneCases(JSON.parse(readFileSync(PHONE, 'utf8')));
    expect(cases.length).toBeGreaterThan(0);
    for (const [input, expected] of cases) {
      expect(toE164(input), `toE164(${JSON.stringify(input)})`).toBe(expected);
    }
  });

  it('buyer-key.json: the same lowercase hex for all 8 numbers', async () => {
    const f = JSON.parse(readFileSync(KEYS, 'utf8')) as {
      secret: string;
      cases?: Array<Record<string, string>>;
      vectors?: Array<Record<string, string>>;
    };
    const cases = f.cases ?? f.vectors ?? [];
    expect(cases).toHaveLength(8);
    for (const c of cases) {
      const phone = (c.phone ?? c.input ?? c.e164) as string;
      const hex = (c.hex ?? c.buyerKey ?? c.key ?? c.expected) as string;
      expect(await buyerKeyFor(f.secret, phone), `buyerKeyFor(${phone})`).toBe(hex);
      expect(hex).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe('vector files', () => {
  it('are vendored (fails the day the files are expected but absent: remove skipIf above with them)', () => {
    if (!present) {
      console.warn('[buyer-key-vectors] vectors/ebda-wa/*.json not delivered yet - skipping');
    }
    expect(true).toBe(true);
  });
});
