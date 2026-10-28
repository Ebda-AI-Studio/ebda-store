// #1192 — package.json declared `overrides.qs` at the top level AND again
// inside `overrides["typed-rest-client"].qs` / `overrides["@lhci/cli"].qs`,
// all pinned to the same 6.16.2 today. Nothing enforces that they stay in
// sync, so the next advisory bump can move the top-level pin while the two
// nested copies quietly re-strand their subtrees on the old version — the
// exact failure mode `qs` has already had here once.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');

describe('qs stays single-sourced through the top-level override (#1192)', () => {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
    overrides: Record<string, unknown>;
  };

  it('has a top-level qs override', () => {
    expect(pkg.overrides.qs).toBe('6.16.2');
  });

  it('no nested override re-declares qs — the top-level pin must be the only source', () => {
    const offenders: string[] = [];
    for (const [name, value] of Object.entries(pkg.overrides)) {
      if (name === 'qs' || typeof value !== 'object' || value === null) continue;
      if ('qs' in (value as Record<string, unknown>)) offenders.push(name);
    }
    expect(offenders, `overrides re-declaring qs: ${offenders.join(', ')}`).toEqual([]);
  });

  it('package-lock.json resolves qs to exactly one version, matching the override', () => {
    const lock = JSON.parse(readFileSync(resolve(ROOT, 'package-lock.json'), 'utf8')) as {
      packages: Record<string, { version?: string }>;
    };
    const versions = new Set(
      Object.entries(lock.packages ?? {})
        .filter(([path]) => /(^|\/)node_modules\/qs$/.test(path))
        .map(([, meta]) => meta.version)
        .filter((v): v is string => Boolean(v))
    );
    expect(
      versions.size,
      `qs resolved to more than one version in the lockfile: ${[...versions].join(', ')}`
    ).toBeLessThanOrEqual(1);
    if (versions.size === 1) {
      expect([...versions][0]).toBe(pkg.overrides.qs);
    }
  });
});
