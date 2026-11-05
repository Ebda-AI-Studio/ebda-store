import { describe, it, expect, vi } from 'vitest';
import { setCfBindings, clearCfBindings } from '../../apps/api/src/cf/bindings';
import { getAccountsBrief } from '../../apps/api/src/lib/identity-client';

describe('getAccountsBrief (api client)', () => {
  it('dedupes, chunks by 100 and concatenates; an unavailable service is a 503', async () => {
    const calls: number[] = [];
    setCfBindings({
      ACCOUNTS: {
        getAccountsBrief: async (ids: string[]) => (
          calls.push(ids.length),
          ids.map(id => ({ id }))
        ),
      },
    } as never);
    const ids = Array.from({ length: 250 }, (_, i) => `id-${i}`);
    const out = await getAccountsBrief([...ids, ...ids.slice(0, 10)]);
    expect(out).toHaveLength(250);
    expect(calls).toEqual([100, 100, 50]);
    setCfBindings({ ACCOUNTS: {} } as never);
    await expect(getAccountsBrief(['x'])).rejects.toMatchObject({ statusCode: 503 });
    clearCfBindings();
    void vi;
  });
});
