import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs script without types
import { findMissing, loadAllowlist } from '../../scripts/ci/env-docs-check.mjs';

describe('docs/ENVIRONMENT.md parity', () => {
  it('documents every env name the code reads (or allowlists it with a reason)', () => {
    const missing = findMissing() as { name: string; files: string[] }[];
    expect(
      missing.map(m => `${m.name} (${m.files[0]})`),
      'add these names to docs/ENVIRONMENT.md or scripts/ci/env-docs-allowlist.json'
    ).toEqual([]);
  });

  it('every allowlist entry carries a reason', () => {
    const allow = loadAllowlist() as Record<string, string>;
    for (const [name, reason] of Object.entries(allow)) {
      expect(reason.trim().length, name).toBeGreaterThan(10);
    }
  });
});
