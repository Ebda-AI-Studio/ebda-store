import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IMAGE_VARIANT_WIDTHS, variantKeysFor } from '@force/shared';
import { classifyOrphans } from '../../scripts/r2-orphan-audit';

const OLD = new Date('2026-01-01T00:00:00Z');
const NOW = Date.UTC(2026, 7, 18);
const DAY = 24 * 3600_000;

describe('r2 orphan audit ignores image variants', () => {
  it('never reports a variant as an orphan, and keeps non-variant behaviour', () => {
    const orig = 'stores/s/products/u-a.jpg';
    const objs = [orig, ...variantKeysFor(orig), 'stores/s/products/u-b.png'].map(key => ({
      key,
      size: 10,
      lastModified: OLD,
    }));
    // original referenced -> variants must not become orphans just because they are unreferenced
    const r = classifyOrphans(objs, new Set([orig]), DAY, NOW);
    expect(r.orphans).toEqual(['stores/s/products/u-b.png']);
    expect(r.totalBytes).toBe((IMAGE_VARIANT_WIDTHS.length + 2) * 10);
  });
});

// ── weekly Inngest sweep ──────────────────────────────────────────────
const sent: Array<{ name: string; input: any }> = [];
let listed: Array<{ Key: string; Size: number; LastModified: Date }> = [];
let handler: (ctx: any) => Promise<any>;

vi.mock('../../apps/api/src/lib/inngest/client', () => ({
  inngest: {
    createFunction: (_o: unknown, h: (ctx: any) => Promise<any>) => {
      handler = h;
      return {};
    },
  },
}));
vi.mock('../../apps/api/src/lib/lazy-modules', () => {
  const cmd = (name: string) =>
    class {
      input: any;
      name = name;
      constructor(i: any) {
        this.input = i;
      }
    };
  return {
    loadS3: async () => ({
      S3Client: class {
        async send(c: any) {
          sent.push({ name: c.name, input: c.input });
          if (c.name === 'ListObjectsV2Command') return { Contents: listed, IsTruncated: false };
          return {};
        }
      },
      ListObjectsV2Command: cmd('ListObjectsV2Command'),
      DeleteObjectsCommand: cmd('DeleteObjectsCommand'),
    }),
  };
});
vi.mock('@force/database', () => ({
  prisma: {},
  isOwnerRole: async () => true,
  withOwnerTx: async (fn: any) => fn({}),
}));
vi.mock('../../apps/api/src/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
const sendAlert = vi.fn();
vi.mock('../../apps/api/src/services/alerts.service', () => ({
  sendAlert: (a: any) => sendAlert(a),
}));
vi.mock('../../apps/api/src/services/r2-cleanup.service', () => ({ urlToR2Key: () => null }));
vi.mock('../../apps/api/src/lib/r2-references', () => ({
  collectReferencedR2Keys: async () => new Set(['stores/s/products/u-a.jpg']),
  assertStrictTablesVisible: async () => undefined,
}));
vi.mock('../../apps/api/src/config', () => ({
  config: {
    storageEndpoint: 'https://e',
    storageAccessKey: 'k',
    storageSecretKey: 's',
    storageBucket: 'b',
  },
}));

describe('r2-orphan-sweep and image variants', () => {
  beforeEach(async () => {
    sent.length = 0;
    sendAlert.mockClear();
    await import('../../apps/api/src/lib/inngest/functions/r2-orphan-sweep');
  });

  const step = {
    run: async (_n: string, fn: () => Promise<unknown>) => JSON.parse(JSON.stringify(await fn())),
  };

  it('does not report variants of a live original as orphans', async () => {
    const orig = 'stores/s/products/u-a.jpg';
    listed = [orig, ...variantKeysFor(orig)].map(Key => ({
      Key,
      Size: 5,
      LastModified: new Date('2026-01-01'),
    }));
    const out = await handler({ step });
    expect(out.orphanCount).toBe(0);
    expect(out.totalKeys).toBe(IMAGE_VARIANT_WIDTHS.length + 1);
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it('deletes an orphaned original together with its variants (apply mode)', async () => {
    process.env.R2_ORPHAN_SWEEP_APPLY = 'true';
    try {
      const orphan = 'stores/s/products/u-gone.jpg';
      listed = [orphan, ...variantKeysFor(orphan)].map(Key => ({
        Key,
        Size: 5,
        LastModified: new Date('2026-01-01'),
      }));
      const out = await handler({ step });
      expect(out.orphanCount).toBe(1);
      const del = sent.find(s => s.name === 'DeleteObjectsCommand')!;
      expect(del.input.Delete.Objects.map((o: any) => o.Key).sort()).toEqual(
        [orphan, ...variantKeysFor(orphan)].sort()
      );
    } finally {
      delete process.env.R2_ORPHAN_SWEEP_APPLY;
    }
  });
});
