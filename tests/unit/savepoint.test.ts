/**
 * #1595 — a failing `ROLLBACK TO SAVEPOINT` must never replace the error the
 * caller's recovery keys on. `cart.service.ts` recovers a lost unique race by
 * checking `err.code === 'P2002'`; if the rollback's own failure (closed tx,
 * dropped connection) were thrown instead, that recovery could never run.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const hasTenantContextMock = vi.fn();
const execMock = vi.fn();

vi.mock('@ebda/database', () => ({
  prisma: { $executeRawUnsafe: (q: string) => execMock(q) },
  hasTenantContext: () => hasTenantContextMock(),
}));
vi.mock('@api/lib/logger', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const { withSavepoint, withSavepointOn } = await import('@api/lib/savepoint');

class P2002 extends Error {
  code = 'P2002';
}

beforeEach(() => {
  vi.clearAllMocks();
  hasTenantContextMock.mockReturnValue(true);
  execMock.mockResolvedValue(0);
});

describe('withSavepoint — original error survives a failed rollback', () => {
  it('rethrows the original P2002 when ROLLBACK TO SAVEPOINT itself rejects', async () => {
    execMock.mockImplementation(async (q: string) => {
      if (q.startsWith('ROLLBACK TO SAVEPOINT')) throw new Error('P2028 transaction closed');
      return 0;
    });
    const original = new P2002('unique');
    await expect(withSavepoint(() => Promise.reject(original))).rejects.toBe(original);
  });

  it('rolls back AND releases the savepoint on failure', async () => {
    await expect(withSavepoint(() => Promise.reject(new P2002('unique')))).rejects.toBeInstanceOf(
      P2002
    );
    const stmts = execMock.mock.calls.map(c => String(c[0]).split(' "')[0]);
    expect(stmts).toEqual(['SAVEPOINT', 'ROLLBACK TO SAVEPOINT', 'RELEASE SAVEPOINT']);
  });

  it('releases on success and returns the result', async () => {
    await expect(withSavepoint(async () => 42)).resolves.toBe(42);
    const stmts = execMock.mock.calls.map(c => String(c[0]).split(' "')[0]);
    expect(stmts).toEqual(['SAVEPOINT', 'RELEASE SAVEPOINT']);
  });

  it('is a pass-through outside a tenant context', async () => {
    hasTenantContextMock.mockReturnValue(false);
    await expect(withSavepoint(async () => 'x')).resolves.toBe('x');
    expect(execMock).not.toHaveBeenCalled();
  });

  it('withSavepointOn (explicit tx, journal.service) keeps the original error too', async () => {
    const tx = {
      $executeRawUnsafe: vi.fn(async (q: string) => {
        if (q.startsWith('ROLLBACK')) throw new Error('connection dropped');
        return 0;
      }),
    };
    const original = new P2002('unique');
    await expect(withSavepointOn(tx, () => Promise.reject(original))).rejects.toBe(original);
  });
});
