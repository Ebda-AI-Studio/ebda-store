import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs script, no types
import { findCilessPrs } from '../../../scripts/ci/reopen-ciless-prs.mjs';

const NOW = Date.parse('2026-11-16T14:30:00Z');
const old = '2026-11-16T14:01:15Z';
const pr = (over = {}) => ({
  number: 872,
  draft: false,
  base: 'main',
  headSha: 'a',
  headDate: old,
  ...over,
});
const ci = [{ name: 'CI', event: 'pull_request' }];
// G56: AI review / PR quality (pull_request_target) ran, CI (pull_request) never did.
const targetOnly = [
  { name: 'AI review', event: 'pull_request_target' },
  { name: 'PR quality', event: 'pull_request_target' },
];

describe('reopen-ciless-prs (G56)', () => {
  it('flags an old head with only pull_request_target runs', () => {
    expect(findCilessPrs([pr()], { a: targetOnly }, NOW)).toHaveLength(1);
  });
  it('flags an old head with no runs at all', () => {
    expect(findCilessPrs([pr()], {}, NOW)).toHaveLength(1);
  });
  it('leaves a head that has a CI run', () => {
    expect(findCilessPrs([pr()], { a: [...targetOnly, ...ci] }, NOW)).toHaveLength(0);
  });
  it('waits for a fresh head', () => {
    expect(findCilessPrs([pr({ headDate: '2026-11-16T14:25:00Z' })], {}, NOW)).toHaveLength(0);
  });
  it('ignores drafts and non-main bases', () => {
    expect(findCilessPrs([pr({ draft: true }), pr({ base: 'x' })], {}, NOW)).toHaveLength(0);
  });
});
