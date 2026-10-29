import { describe, expect, it, vi } from 'vitest';
import { createDatabaseRoleGuard } from '../../apps/api/src/cf/database-role-guard';

const safe = [{ currentUser: 'ebda_app', bypass: false, ownsUnforcedRls: false }];

describe('Worker database role guard', () => {
  it('caches only verified safe role success', async () => {
    const guard = createDatabaseRoleGuard();
    const query = vi.fn().mockResolvedValue(safe);
    await guard(query);
    await guard(query);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['bypass role', [{ currentUser: 'owner', bypass: true }]],
    ['missing role', []],
    ['unknown bypass state', [{ currentUser: 'unknown' }]],
    // Ruling F9-ROLE-1: a table owner is exempt from RLS unless the table is FORCE'd, so an owner role with
    // NOBYPASSRLS is just as unsafe as a bypass role.
    [
      'owner of an RLS table that is not FORCEd',
      [{ currentUser: 'migrator', bypass: false, ownsUnforcedRls: true }],
    ],
    ['unknown ownership state', [{ currentUser: 'x', bypass: false }]],
  ])('rejects %s and permits a later successful retry', async (_name, rows) => {
    const guard = createDatabaseRoleGuard();
    await expect(guard(async () => rows as typeof safe)).rejects.toThrow('Unsafe or unverifiable');
    await expect(guard(async () => safe)).resolves.toBeUndefined();
  });

  it('propagates a failed query and retries instead of caching failure', async () => {
    const guard = createDatabaseRoleGuard();
    const query = vi
      .fn()
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValue(safe);
    await expect(guard(query)).rejects.toThrow('database unavailable');
    await expect(guard(query)).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('awaits validation and uses each concurrent invocation own query', async () => {
    const guard = createDatabaseRoleGuard();
    let finish!: (rows: typeof safe) => void;
    const firstQuery = vi.fn(
      () =>
        new Promise<typeof safe>(resolve => {
          finish = resolve;
        })
    );
    const application = vi.fn();
    const first = guard(firstQuery).then(application);
    const secondQuery = vi.fn().mockResolvedValue(safe);
    await guard(secondQuery);
    expect(application).not.toHaveBeenCalled();
    expect(secondQuery).toHaveBeenCalledTimes(1);
    finish(safe);
    await first;
    expect(application).toHaveBeenCalledTimes(1);
  });
});
