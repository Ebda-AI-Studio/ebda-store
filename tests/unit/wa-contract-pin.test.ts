/**
 * The Store <-> WhatsApp envelope is ONE file in two repos. This pins the vendored copy to the
 * Ebda WhatsApp repo's bytes (branch feat/phase4-7, src/core/api/store-events.ts): a change here
 * must be a deliberate, mirrored one.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const FILE = path.resolve(__dirname, '../../apps/api/src/contracts/ebda-wa-v1.ts');
const PINNED = '91a7faffa1d1a1aae416f840d0006596ca1e4f226b35efa24c04771199582d0d';

describe('ebda-wa-v1 envelope', () => {
  it('is byte-identical to the Ebda WhatsApp copy (sha256 pin)', () => {
    expect(createHash('sha256').update(readFileSync(FILE)).digest('hex')).toBe(PINNED);
  });
});
