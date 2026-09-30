/**
 * #648: verify-baseline-nodrift.mjs's query included Pecannbee (id-pinned,
 * since its slug may change at the domain cutover) but the GATING branch
 * only matched `s.slug === 'wady-aljuz'`. Pecannbee — a LIVE CLIENT STORE —
 * fell into the `else` (not-gated) branch, which never set `failed = true`
 * no matter how far its resolved layout drifted, and hardcoded the label
 * "palora" in the log regardless of which store it actually was. A resolved-
 * layout regression on Pecannbee would have passed this gate silently.
 */
import { describe, it, expect } from 'vitest';
import {
  isGated,
  missingGatedStores,
  GATED_STORE_COUNT,
} from '../../packages/database/scripts/verify-baseline-nodrift.mjs';

const PECANNBEE_ID = '359afc1f-ea5b-4f8d-b372-c038c6c057f7';

describe('verify-baseline-nodrift isGated', () => {
  it('gates wady-aljuz by slug', () => {
    expect(isGated({ slug: 'wady-aljuz', id: 'anything' })).toBe(true);
  });

  it('#648: gates pecannbee by id, regardless of its current slug', () => {
    expect(isGated({ slug: 'pecannbee', id: PECANNBEE_ID })).toBe(true);
    // The whole point of pinning by id: the slug may change at the domain
    // cutover, and the gate must not silently stop covering the store then.
    expect(isGated({ slug: 'some-future-renamed-slug', id: PECANNBEE_ID })).toBe(true);
  });

  it('does not gate palora — it intentionally adopts the baseline', () => {
    expect(isGated({ slug: 'palora', id: 'other-id' })).toBe(false);
  });

  it('does not gate an unrelated store', () => {
    expect(isGated({ slug: 'some-other-store', id: 'random-id' })).toBe(false);
  });
});

// Issue 2219: an empty/partial query result used to print PASS having compared
// nothing. Every pinned store must resolve or the run is broken.
describe('verify-baseline-nodrift missingGatedStores', () => {
  const wady = { slug: 'wady-aljuz', id: 'w-id' };
  const pecan = { slug: 'pecannbee', id: PECANNBEE_ID };

  it('an EMPTY result is a broken run, not a pass — both pins reported missing', () => {
    const missing = missingGatedStores([]);
    expect(missing).toHaveLength(GATED_STORE_COUNT);
    expect(missing.join(' ')).toMatch(/wady-aljuz/);
    expect(missing.join(' ')).toMatch(new RegExp(PECANNBEE_ID));
  });

  it('a PARTIAL result names exactly the missing pin', () => {
    expect(missingGatedStores([wady])).toEqual([`id ${PECANNBEE_ID}`]);
    expect(missingGatedStores([pecan, { slug: 'palora', id: 'p' }])).toEqual(['slug wady-aljuz']);
  });

  it('full coverage reports nothing missing (palora is extra, not required)', () => {
    expect(missingGatedStores([wady, pecan])).toEqual([]);
  });
});
