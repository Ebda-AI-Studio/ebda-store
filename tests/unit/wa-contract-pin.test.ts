/**
 * The Store <-> WhatsApp envelope is ONE file in two repos. This pins the vendored copy to the
 * Ebda WhatsApp repo's bytes (commit 16abd6a + v1.4 pastDueSince (WA-GRACE-1), src/core/api/store-events.ts; the Store's copy is contracts/wa-v1.ts): a change here
 * must be a deliberate, mirrored one.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const FILE = path.resolve(__dirname, '../../apps/api/src/contracts/wa-v1.ts');
const PINNED = 'a32c8b4936d43cae8f230e13cc38804fb03f7eaa3ed30731841c7637e4b57a05';

describe('ebda-wa-v1 envelope', () => {
  it('is byte-identical to the Ebda WhatsApp copy (sha256 pin)', () => {
    expect(createHash('sha256').update(readFileSync(FILE)).digest('hex')).toBe(PINNED);
  });
});
