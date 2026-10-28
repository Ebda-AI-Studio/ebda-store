/**
 * The status Worker serves the shared live-search client itself (it must not depend on another Ebda site being up).
 * The committed bundle must equal a fresh bundle of packages/site-kit/src/client/typeahead.js: after editing the
 * client run `npm run gen:typeahead -w apps/status`.
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs
import { bundled } from '../../apps/status/scripts/gen-typeahead.mjs';
import { TYPEAHEAD_JS } from '../../apps/status/src/typeahead-bundle';

describe('status typeahead bundle', () => {
  it('is current', async () => {
    expect(TYPEAHEAD_JS).toBe(await bundled());
  });
});
