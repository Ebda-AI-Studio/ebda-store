/**
 * The Store <-> WhatsApp envelope is ONE file in two repos. This pins the vendored copy to the
 * Ebda WhatsApp repo's bytes (commit 1cfb45b, src/core/api/store-events.ts; the Store's copy is contracts/wa-v1.ts): a change here
 * must be a deliberate, mirrored one.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const FILE = path.resolve(__dirname, '../../apps/api/src/contracts/wa-v1.ts');
const PINNED = 'df57a0f02ae390d2b174b2f2e68217ac76810da402e38bb645da9c0e5a65b4ec';

describe('ebda-wa-v1 envelope', () => {
  it('is byte-identical to the Ebda WhatsApp copy (sha256 pin)', () => {
    expect(createHash('sha256').update(readFileSync(FILE)).digest('hex')).toBe(PINNED);
  });
});
