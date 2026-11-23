/**
 * #615 / S3-X8: the plan storage ceiling applies to EVERY merchant write into the public bucket (usage is the listing
 * under stores/<id>/). This fails when a new route (or service) calls StorageService.upload / uploadMultiple without
 * assertStorageRoom, or without being listed as reached only through a gated route.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '../..');
const read = (f: string) => readFileSync(join(root, f), 'utf8');

/** A service that writes to R2 for a merchant is gated by the route that calls it. */
const GATED_BY_ROUTE: Record<string, string> = {
  'apps/api/src/services/pwa.service.ts': 'apps/api/src/routes/pwa.routes.ts',
};

function filesCallingPublicUpload(): string[] {
  let out = '';
  try {
    out = execFileSync(
      'git',
      [
        'grep',
        '-lE',
        'StorageService\\.(upload|uploadMultiple)\\(',
        '--',
        'apps/api/src',
        ':!*.test.*',
        ':!apps/api/src/services/storage.service.ts',
      ],
      { cwd: root, encoding: 'utf8' }
    );
  } catch {
    /* git grep exits 1 on no match */
  }
  return out.split('\n').filter(Boolean);
}

describe('every public-bucket upload checks the plan storage ceiling', () => {
  const files = filesCallingPublicUpload();
  it('finds the known upload sites (so the scan itself cannot rot to empty)', () => {
    for (const f of [
      'apps/api/src/routes/upload.routes.ts',
      'apps/api/src/routes/product-model.routes.ts',
      'apps/api/src/services/pwa.service.ts',
    ])
      expect(files, f).toContain(f);
  });
  for (const f of files) {
    it(`${f} is gated`, () => {
      const gate = GATED_BY_ROUTE[f];
      expect(read(gate ?? f), gate ? `${gate} must gate ${f}` : f).toMatch(/assertStorageRoom\(/);
    });
  }
  it('the 3D model routes gate both the glb and the usdz upload', () => {
    expect(
      read('apps/api/src/routes/product-model.routes.ts').match(/assertStorageRoom\(/g)?.length
    ).toBe(2);
  });
});
