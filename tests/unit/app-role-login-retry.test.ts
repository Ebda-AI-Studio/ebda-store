import { describe, it, expect, vi } from 'vitest';
import { setAppRoleLogin } from '../helpers/app-role-login';

describe('setAppRoleLogin', () => {
  it('retries "tuple concurrently updated" and then succeeds', async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error('ERROR: tuple concurrently updated'))
      .mockRejectedValueOnce(new Error('tuple concurrently updated'))
      .mockResolvedValue(0);
    await setAppRoleLogin({ $executeRawUnsafe: run }, "pw'x");
    expect(run).toHaveBeenCalledTimes(3);
    expect(run.mock.calls[0][0]).toContain("PASSWORD 'pw''x'");
  });
  it('does not retry any other error', async () => {
    const run = vi.fn().mockRejectedValue(new Error('permission denied to alter role'));
    await expect(setAppRoleLogin({ $executeRawUnsafe: run }, 'pw')).rejects.toThrow(
      /permission denied/
    );
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('gives up after the attempt budget instead of hiding a stuck lock', async () => {
    const run = vi.fn().mockRejectedValue(new Error('tuple concurrently updated'));
    await expect(setAppRoleLogin({ $executeRawUnsafe: run }, 'pw', 3)).rejects.toThrow(
      /concurrently/
    );
    expect(run).toHaveBeenCalledTimes(3);
  });
});
