/**
 * The Store <-> WhatsApp envelope is ONE file in two repos. This pins the vendored copy to the
 * Ebda Chat repo's bytes (commit 16abd6a + v1.4 pastDueSince (WA-GRACE-1) + v1.5 wording (WA-OPTIN-WORDING-1) + v1.6 store standing (STORE-STANDING-1), src/core/api/store-events.ts; the Store's copy is contracts/wa-v1.ts): a change here
 * must be a deliberate, mirrored one.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const FILE = path.resolve(__dirname, '../../apps/api/src/contracts/wa-v1.ts');
const PINNED = 'abf04536b60312801a34aa759ae9ed138030af46a00345ccc2cc10ebd863ecac';

describe('ebda-wa-v1 envelope', () => {
  it('is byte-identical to the Ebda Chat copy (sha256 pin)', () => {
    expect(createHash('sha256').update(readFileSync(FILE)).digest('hex')).toBe(PINNED);
  });
});
