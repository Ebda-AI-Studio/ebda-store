/**
 * The RLS-visibility guard (`assertStrictTablesVisible`) sits in front of every bulk R2 delete (issues 2251/2288/2354).
 * Behaviour, not source order: both bulk-delete collectors, `scripts/r2-orphan-audit.ts` (run as a CLI) and the weekly
 * Inngest `r2-orphan-sweep`, are RUN with the S3 client, the database and the guard replaced by recorders. The recorded
 * event order proves the guard ran before the first delete, and a refusing guard proves nothing was deleted.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const old = new Date(Date.now() - 10 * 86_400_000);
const h = vi.hoisted(() => ({
  events: [] as string[],
  guardRefuses: false,
  done: null as null | (() => void),
}));

vi.mock('@aws-sdk/client-s3', () => ({
  ListObjectsV2Command: class {
    constructor(public i: unknown) {}
  },
  DeleteObjectsCommand: class {
    constructor(public i: unknown) {}
  },
  S3Client: class {
    async send(cmd: { constructor: { name: string } }) {
      if (cmd.constructor.name === 'DeleteObjectsCommand') {
        h.events.push('delete');
        return {};
      }
      return { Contents: [{ Key: 'stores/x/orphan.jpg', Size: 10, LastModified: old }] };
    }
  },
}));
vi.mock('@api/lib/lazy-modules', () => ({
  loadS3: async () => await import('@aws-sdk/client-s3'),
}));
vi.mock('fs', async importOriginal => {
  const real = await importOriginal<typeof import('fs')>();
  const writeFileSync = () => {
    h.events.push('report');
    h.done?.();
  };
  return { ...real, writeFileSync, default: { ...real, writeFileSync } };
});
vi.mock('@ebda/database', async () => ({
  createPrismaClient: () => ({ $transaction: async () => undefined, $disconnect: async () => {} }),
  prisma: {},
  isOwnerRole: async () => true,
  withOwnerTx: async (fn: (tx: unknown) => unknown) => fn({}),
  storeDirectory: async () => [],
  withoutHiddenStores: <T>(fn: () => T) => fn(),
}));
vi.mock('@api/lib/r2-references', async importOriginal => ({
  ...(await importOriginal<typeof import('@api/lib/r2-references')>()),
  collectReferencedR2Keys: async () => new Set<string>(),
  assertStrictTablesVisible: async () => {
    h.events.push('guard');
    if (h.guardRefuses) throw new Error('REFUSING: strict tables not visible');
  },
}));
vi.mock('@api/config', () => ({
  config: {
    storageEndpoint: 'e',
    storageAccessKey: 'k',
    storageSecretKey: 's',
    storageBucket: 'b',
  },
}));
vi.mock('@api/lib/platform-directory', () => ({ platformDb: () => undefined }));
vi.mock('@api/lib/r2-platform-d1-references', () => ({
  platformD1ReferencedKeys: async () => new Set<string>(),
}));
vi.mock('@api/lib/r2-do-references', () => ({ collectDoStoreReferencedKeys: async () => [] }));
vi.mock('@api/services/r2-cleanup.service', () => ({ urlToR2Key: () => null }));
vi.mock('@api/services/alerts.service', () => ({ sendAlert: async () => 'sent' }));
vi.mock('@api/lib/inngest/client', () => ({
  inngest: { createFunction: (options: unknown, handler: unknown) => ({ options, handler }) },
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

beforeEach(() => {
  h.events.length = 0;
  h.guardRefuses = false;
  h.done = null;
  vi.resetModules();
  vi.unstubAllEnvs();
});

/** Run scripts/r2-orphan-audit.ts as the CLI does (its direct-run check reads process.argv[1]). */
async function runAuditCli(flags: string[]): Promise<'finished' | 'failed'> {
  vi.stubEnv('STORAGE_ENDPOINT', 'https://e.example');
  vi.stubEnv('STORAGE_ACCESS_KEY', 'k');
  vi.stubEnv('STORAGE_SECRET_KEY', 's');
  vi.stubEnv('STORAGE_BUCKET', 'b');
  vi.stubEnv('DATABASE_URL', 'postgres://x');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const argv = process.argv;
  const outcome = new Promise<'finished' | 'failed'>(resolve => {
    h.done = () => resolve('finished');
    vi.spyOn(process, 'exit').mockImplementation((() => {
      resolve('failed');
    }) as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  process.argv = ['node', '/repo/scripts/r2-orphan-audit.ts', ...flags];
  try {
    await import('../../scripts/r2-orphan-audit');
    return await outcome;
  } finally {
    process.argv = argv;
    vi.restoreAllMocks();
  }
}

describe('scripts/r2-orphan-audit.ts (CLI)', () => {
  it('--apply: the visibility guard runs BEFORE the first delete', async () => {
    expect(await runAuditCli(['--apply'])).toBe('finished');
    expect(h.events.indexOf('guard')).toBeGreaterThanOrEqual(0);
    expect(h.events.indexOf('delete')).toBeGreaterThan(h.events.indexOf('guard'));
  });

  it('--apply with a refusing guard deletes nothing and the audit fails', async () => {
    h.guardRefuses = true;
    expect(await runAuditCli(['--apply'])).toBe('failed');
    expect(h.events).toEqual(['guard']);
  });

  it('the dry run validates the report too: the guard runs when anything would be called an orphan, and nothing is deleted', async () => {
    expect(await runAuditCli([])).toBe('finished');
    expect(h.events).toEqual(['guard', 'report']);
  });
});

describe('Inngest r2-orphan-sweep (the other bulk-delete collector)', () => {
  const step = {
    run: async <T>(_id: string, fn: () => Promise<T>): Promise<T> =>
      JSON.parse(JSON.stringify(await fn())),
  };
  const sweep = async () => {
    const { r2OrphanSweep } = await import('@api/lib/inngest/functions/r2-orphan-sweep');
    return (r2OrphanSweep as unknown as { handler: (a: unknown) => Promise<unknown> }).handler({
      step,
    });
  };

  it('runs the same guard before deleting', async () => {
    vi.stubEnv('R2_ORPHAN_SWEEP_APPLY', 'true');
    await sweep();
    expect(h.events.indexOf('guard')).toBeGreaterThanOrEqual(0);
    expect(h.events.indexOf('delete')).toBeGreaterThan(h.events.indexOf('guard'));
  });

  it('with deletes on, a refusing guard throws and deletes nothing', async () => {
    vi.stubEnv('R2_ORPHAN_SWEEP_APPLY', 'true');
    h.guardRefuses = true;
    await expect(sweep()).rejects.toThrow(/not deleting/);
    expect(h.events).toEqual(['guard']);
  });

  it('in report-only mode a refusing guard does not throw and still deletes nothing', async () => {
    h.guardRefuses = true;
    await expect(sweep()).resolves.toMatchObject({ orphanCount: 1 });
    expect(h.events).toEqual(['guard']);
  });
});
