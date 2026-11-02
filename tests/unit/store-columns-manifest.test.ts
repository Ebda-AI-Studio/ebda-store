import { describe, it, expect } from 'vitest';
import manifest from '../../packages/cf-schema/generated/manifest.json';
import {
  STORE_D1_ONLY_FIELDS,
  STORE_MIRROR_FIELDS,
  d1StorePatch,
} from '../../apps/api/src/lib/store-columns';

describe('store-columns is pinned to the generated Store split (Ruling NZ-D8)', () => {
  it('d1Only and mirror lists equal manifest.storeSplit', () => {
    expect([...STORE_D1_ONLY_FIELDS]).toEqual(manifest.storeSplit.d1Only);
    expect([...STORE_MIRROR_FIELDS]).toEqual(manifest.storeSplit.mirror);
  });
  it('d1StorePatch keeps D1-owned fields only and never the id', () => {
    expect(
      d1StorePatch({
        id: 'x',
        name: 'n',
        theme: {},
        deletedAt: null,
        taxEnabled: true,
        slug: undefined,
      })
    ).toEqual({ name: 'n', deletedAt: null });
  });
});
