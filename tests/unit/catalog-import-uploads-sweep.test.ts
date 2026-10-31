import { describe, it, expect } from 'vitest';
import {
  sweepExpiredCatalogueUploads,
  CATALOGUE_UPLOAD_MAX_AGE_MS,
  type SweepBucket,
} from '@api/lib/catalogue/expired-uploads-sweep';

const NOW = new Date('2026-11-20T00:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const DAY = 86_400_000;

function fakeBucket(objs: Record<string, Date>): SweepBucket & { keys: () => string[] } {
  return {
    keys: () => Object.keys(objs).sort(),
    async listStorePrefixes() {
      return [...new Set(Object.keys(objs).map(k => k.split('/').slice(0, 2).join('/') + '/'))];
    },
    async listObjects(prefix) {
      return Object.entries(objs)
        .filter(([k]) => k.startsWith(prefix))
        .map(([key, lastModified]) => ({ key, lastModified }));
    },
    async deleteObjects(keys) {
      for (const k of keys) delete objs[k];
      return { deleted: keys.length, failed: 0 };
    },
  };
}

describe('catalogue import expired uploads sweep (CATIMP-6)', () => {
  const seed = () => ({
    'stores/s1/catalogimport-j1/a.jpg': ago(40 * DAY),
    'stores/s1/catalogimport-j2/b.pdf': ago(5 * DAY),
    'stores/s2/catalogimport-j3/c.jpg': ago(CATALOGUE_UPLOAD_MAX_AGE_MS + 1000),
    'stores/s2/documents/old.pdf': ago(400 * DAY),
    'stores/s2/catalogimport-j3': ago(400 * DAY),
  });

  it('deletes only expired catalogimport objects, keeps fresh and unrelated keys', async () => {
    const b = fakeBucket(seed());
    const r = await sweepExpiredCatalogueUploads(b, NOW);
    expect(r).toMatchObject({ storesScanned: 2, expired: 2, deleted: 2, failed: 0, capped: false });
    expect(b.keys()).toEqual([
      'stores/s1/catalogimport-j2/b.pdf',
      'stores/s2/catalogimport-j3',
      'stores/s2/documents/old.pdf',
    ]);
  });

  it('is idempotent: a second run deletes nothing', async () => {
    const b = fakeBucket(seed());
    await sweepExpiredCatalogueUploads(b, NOW);
    const again = await sweepExpiredCatalogueUploads(b, NOW);
    expect(again).toMatchObject({ expired: 0, deleted: 0, failed: 0 });
  });

  it('result carries counts only, no keys or ids', async () => {
    const r = await sweepExpiredCatalogueUploads(fakeBucket(seed()), NOW);
    expect(Object.values(r).every(v => typeof v === 'number' || typeof v === 'boolean')).toBe(true);
  });
});
