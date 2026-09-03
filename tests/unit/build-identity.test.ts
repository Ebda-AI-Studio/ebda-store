/**
 * What the running process will say about which build it is.
 *
 * This exists because "merged and green" was not distinguishable from "live".
 * `/health` answered `{status, timestamp}`, so a container still serving the
 * PREVIOUS release looked identical to one serving the new one — and the deploy
 * verification, which checked only for a 200, passed either way.
 *
 * The contract that matters is the null one: not knowing must be reported as
 * not knowing. A guessed or omitted commit would let the verification claim a
 * deploy landed when nothing had changed, which is the failure it exists to
 * catch.
 */

import { describe, it, expect } from 'vitest';
import { buildCommitSha, deploymentId, buildIdentity } from '@api/lib/build-identity';

describe('the commit a build reports', () => {
  it('prefers the value baked into the image', () => {
    expect(buildCommitSha({ BUILD_COMMIT_SHA: 'abc123', RAILWAY_GIT_COMMIT_SHA: 'def456' })).toBe(
      'abc123'
    );
  });

  it('falls back to the platform value when the image was not baked', () => {
    expect(buildCommitSha({ RAILWAY_GIT_COMMIT_SHA: 'def456' })).toBe('def456');
  });

  it('is null when nothing told this build its commit', () => {
    expect(buildCommitSha({})).toBeNull();
  });

  it.each([
    ['empty', ''],
    ['whitespace', '   '],
  ])('treats an %s value as unknown, not as a commit', (_label, value) => {
    // An unset variable and one set to '' carry the same information. Returning
    // '' would compare unequal to the expected sha and read as a MISMATCH —
    // a failed deploy — when the truth is only that nobody said.
    expect(buildCommitSha({ BUILD_COMMIT_SHA: value })).toBeNull();
  });

  it('trims a value that arrived with surrounding whitespace', () => {
    expect(buildCommitSha({ BUILD_COMMIT_SHA: '  abc123\n' })).toBe('abc123');
  });
});

describe('the deployment id a build reports', () => {
  it('reads the platform id', () => {
    expect(deploymentId({ RAILWAY_DEPLOYMENT_ID: 'dep-1' })).toBe('dep-1');
  });

  it('is null when absent or empty', () => {
    expect(deploymentId({})).toBeNull();
    expect(deploymentId({ RAILWAY_DEPLOYMENT_ID: '' })).toBeNull();
  });
});

describe('the identity as /health reports it', () => {
  it('carries both fields when both are known', () => {
    expect(buildIdentity({ BUILD_COMMIT_SHA: 'abc123', RAILWAY_DEPLOYMENT_ID: 'dep-1' })).toEqual({
      commit: 'abc123',
      deploymentId: 'dep-1',
    });
  });

  it('states both as null rather than omitting them', () => {
    // Present-and-null is what lets a caller distinguish "this build will not
    // say" from an older build that predates the field entirely.
    const id = buildIdentity({});
    expect(id).toEqual({ commit: null, deploymentId: null });
    expect(Object.keys(id).sort()).toEqual(['commit', 'deploymentId']);
  });

  it('reports a deployment id even when the commit is unknown', () => {
    // The id changes on every deploy, so it is a usable liveness signal on its
    // own where the commit is not available.
    expect(buildIdentity({ RAILWAY_DEPLOYMENT_ID: 'dep-2' })).toEqual({
      commit: null,
      deploymentId: 'dep-2',
    });
  });
});
