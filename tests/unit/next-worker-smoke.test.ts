import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { patchLoadManifest } from '../../scripts/ci/patch-opennext-preview-props.mjs';
import { PROBES } from '../../scripts/ci/next-worker-smoke.mjs';

const GLOB_1_19_11 = `    const manifests = await glob(join(dotNextDir, "**/{*-manifest,required-server-files,prefetch-hints}.json"), {
        windowsPathsNoEscape: true,
    });`;

describe('OpenNext preview-props backport (Ruling DEP-OPENNEXT-PREVIEW-1)', () => {
  it('adds server/preview-props.json to the inlined manifests of adapter 1.19.11', () => {
    const { source, changed } = patchLoadManifest(`x\n${GLOB_1_19_11}\ny`);
    expect(changed).toBe(true);
    expect(source).toContain('join(dotNextDir, "server/preview-props.json")');
  });
  it('is idempotent and accepts an adapter that already has the fix', () => {
    const once = patchLoadManifest(GLOB_1_19_11).source;
    expect(patchLoadManifest(once).changed).toBe(false);
  });
  it('fails loudly when the adapter shape changed and the fix is absent', () => {
    expect(() => patchLoadManifest('something else entirely')).toThrow(/Upgrade the adapter/);
  });
});

describe('next-worker-smoke probes mirror the deploy probes', () => {
  for (const [app, wf] of [
    ['web', 'web'],
    ['admin', 'admin'],
    ['orders', 'orders'],
  ] as const) {
    it(`${app}: every smoke path+status is a --probe in cf-${wf}-deploy.yml`, () => {
      const yml = readFileSync(`.github/workflows/cf-${wf}-deploy.yml`, 'utf8');
      for (const [p, want] of PROBES[app].paths) {
        expect(yml).toContain(`${PROBES[app].host}${p}|${want}`);
      }
    });
  }

  it('web: the built Worker is also asked for the app manifest route (Ruling PWA-MANIFEST-2)', () => {
    expect(PROBES.web.smokeOnly).toContainEqual([
      '/manifest.webmanifest',
      200,
      'application/manifest+json',
    ]);
  });
});
