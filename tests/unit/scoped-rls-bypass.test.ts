/**
 * #2037 — `withScopedRlsBypass` must put `app.bypass_rls` back on EVERY exit
 * path, restoring the PRIOR value rather than a hardcoded 'false'.
 */
import { describe, it, expect, vi } from 'vitest';
import { withScopedRlsBypass } from '@api/lib/scoped-rls-bypass';

/**
 * A transaction-shaped fake: `SET LOCAL` persists and the read-back echoes it.
 * `outsideTx: true` models the plain non-transactional client, where each
 * statement is its own implicit transaction and SET LOCAL is discarded.
 */
function fakeClient(
  prior: string | null,
  opts: { restoreThrows?: boolean; outsideTx?: boolean } = {}
) {
  const log: string[] = [];
  let sets = 0;
  let current = prior;
  const client = {
    $queryRaw: vi.fn(async () => [{ v: current }]),
    $executeRaw: vi.fn(async (tpl: TemplateStringsArray) => {
      const sql = tpl.join('');
      sets++;
      if (opts.restoreThrows && sets > 1) throw new Error('25P02 current transaction is aborted');
      const v = /'true'/.test(sql) ? 'true' : /'false'/.test(sql) ? 'false' : null;
      if (!opts.outsideTx) current = v;
      log.push(v === 'true' ? 'on' : v === 'false' ? 'off' : sql);
      return 0;
    }),
  };
  return { client: client as never, log };
}

describe('withScopedRlsBypass', () => {
  it('switches the bypass on for fn and off afterwards', async () => {
    const { client, log } = fakeClient(null);
    const seen: string[] = [];
    await withScopedRlsBypass(client, async () => {
      seen.push(log.at(-1)!);
    });
    expect(seen).toEqual(['on']);
    expect(log).toEqual(['on', 'off']);
  });

  it('turns the bypass OFF even when fn throws, and rethrows the original error', async () => {
    const { client, log } = fakeClient('false');
    await expect(
      withScopedRlsBypass(client, async () => {
        throw new Error('IDEMPOTENCY_KEY_REUSED');
      })
    ).rejects.toThrow('IDEMPOTENCY_KEY_REUSED');
    expect(log).toEqual(['on', 'off']);
  });

  it('restores a PRIOR bypass instead of switching it off (caller already under a bypass)', async () => {
    const { client, log } = fakeClient('true');
    await withScopedRlsBypass(client, async () => undefined);
    expect(log).toEqual(['on', 'on']);
  });

  it('surfaces the fn error, not the restore error, when the transaction is aborted', async () => {
    const { client } = fakeClient(null, { restoreThrows: true });
    await expect(
      withScopedRlsBypass(client, async () => {
        throw new Error('23505 unique violation');
      })
    ).rejects.toThrow('23505 unique violation');
  });

  it('a failed restore after a SUCCESSFUL fn is not swallowed', async () => {
    const { client } = fakeClient(null, { restoreThrows: true });
    await expect(withScopedRlsBypass(client, async () => 'ok')).rejects.toThrow('25P02');
  });

  // issue 2123 — mutation-proof: deleting the read-back assertion makes this
  // case resolve (fn runs with RLS still on) and reddens it.
  it('throws instead of running fn when the client is NOT a transaction (SET LOCAL discarded)', async () => {
    const { client } = fakeClient(null, { outsideTx: true });
    const fn = vi.fn(async () => 'bypassed work');
    await expect(withScopedRlsBypass(client, fn)).rejects.toThrow('not inside a transaction');
    expect(fn).not.toHaveBeenCalled();
  });
});
