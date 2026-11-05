/**
 * The Store's phone normaliser and buyer key must produce EXACTLY what Ebda Chat produces (audit
 * CODE-10: two normalisers that differ give one customer two keys). Both repos run the IDENTICAL vector
 * files, created by the WhatsApp session:
 *   tests/vectors/ebda-wa/phone.json      [{ in, e164 | null }]
 *   tests/vectors/ebda-wa/buyer-key.json  { secret, cases: [{ e164, hex }] } (8 numbers)
 * Vendored byte for byte; the sha256 of each is pinned in tests/vectors/ebda-wa/SHA256SUMS so a one-sided
 * edit fails here. Vendored from ebda-whatsapp PR #23 at commit 3f7878d; asserts all 36 phone cases and all 8 keys.
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

/** phone.json is `[{ in, e164 | null }]`. */
function phoneCases(raw: unknown): Array<[string, string | null]> {
  if (!Array.isArray(raw)) throw new Error('phone.json must be an array of { in, e164 }');
  return raw.map((c: { in?: unknown; e164?: unknown }) => {
    if (typeof c.in !== 'string' || !(typeof c.e164 === 'string' || c.e164 === null)) {
      throw new Error(`unrecognised phone.json case ${JSON.stringify(c)}`);
    }
    return [c.in, c.e164];
  });
}

describe('shared vectors with Ebda Chat', () => {
  it('the vendored vector files exist (never skipped: they are committed)', () => {
    expect(present).toBe(true);
  });

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
    expect(cases).toHaveLength(36);
    for (const [input, expected] of cases) {
      expect(toE164(input), `toE164(${JSON.stringify(input)})`).toBe(expected);
    }
  });

  it('buyer-key.json: the same lowercase hex for all 8 numbers', async () => {
    const f = JSON.parse(readFileSync(KEYS, 'utf8')) as {
      secret: string;
      cases: Array<{ e164: string; hex: string }>;
    };
    expect(f.cases).toHaveLength(8);
    for (const c of f.cases) {
      expect(c.hex).toMatch(/^[0-9a-f]{64}$/);
      expect(await buyerKeyFor(f.secret, c.e164), `buyerKeyFor(${c.e164})`).toBe(c.hex);
    }
  });
});
