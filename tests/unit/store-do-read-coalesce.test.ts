/**
 * PERF-BATCH-1: StoreDO reads started in the same microtask share ONE `query` RPC, each caller gets exactly its own results,
 * and a failure of the folded call is answered per caller (each batch re-sent alone), so errors stay where they were.
 */
import { describe, expect, it, vi } from 'vitest';
import { coalesceReads } from '@api/lib/repo-factory';

type R = { ok: true; json: string } | { ok: false; code?: string; message?: string };
const encode = (v: unknown) => JSON.stringify(v);
const decode = <T>(json: string) => JSON.parse(json) as T;
/** A fake DO: answers each query with `<model>:<n>`, refuses a batch holding a `Bad` model. */
function fakeDo() {
  const sent: string[][] = [];
  const send = vi.fn(async (queries: unknown[]): Promise<R> => {
    const models = (queries as Array<{ model: string }>).map(q => q.model);
    sent.push(models);
    if (models.includes('Bad')) return { ok: false, code: 'PRISMA_LITE', message: 'bad' };
    return { ok: true, json: encode(models.map((m, i) => `${m}:${i}`)) };
  });
  return { send, sent };
}

describe('coalesceReads', () => {
  it('three batches started together are ONE call; each caller gets its own slice, in order', async () => {
    const { send, sent } = fakeDo();
    const read = coalesceReads(send, encode, decode);
    const [a, b, c] = await Promise.all([
      read([{ model: 'TaxRate' }, { model: 'StoreTaxProfile' }]),
      read([{ model: 'StoreFaq' }]),
      read([{ model: 'StorePage' }]),
    ]);
    expect(sent).toEqual([['TaxRate', 'StoreTaxProfile', 'StoreFaq', 'StorePage']]);
    expect(decode(a.ok ? a.json : '')).toEqual(['TaxRate:0', 'StoreTaxProfile:1']);
    expect(decode(b.ok ? b.json : '')).toEqual(['StoreFaq:2']);
    expect(decode(c.ok ? c.json : '')).toEqual(['StorePage:3']);
  });

  it('batches started in different turns are separate calls (nothing waits for a later read)', async () => {
    const { send, sent } = fakeDo();
    const read = coalesceReads(send, encode, decode);
    await read([{ model: 'A' }]);
    await read([{ model: 'B' }]);
    expect(sent).toEqual([['A'], ['B']]);
  });

  it('a failed folded call is answered per caller: only the failing batch fails', async () => {
    const { send, sent } = fakeDo();
    const read = coalesceReads(send, encode, decode);
    const [ok, bad] = await Promise.all([read([{ model: 'StoreFaq' }]), read([{ model: 'Bad' }])]);
    expect(sent).toEqual([['StoreFaq', 'Bad'], ['StoreFaq'], ['Bad']]);
    expect(ok).toEqual({ ok: true, json: encode(['StoreFaq:0']) });
    expect(bad.ok).toBe(false);
  });

  it('a thrown folded call is retried per caller; a caller whose own call throws gets the throw', async () => {
    let n = 0;
    const send = vi.fn(async (queries: unknown[]): Promise<R> => {
      n++;
      if (n === 1 || (queries as Array<{ model: string }>)[0].model === 'Boom')
        throw new Error('rpc');
      return { ok: true, json: encode(['x']) };
    });
    const read = coalesceReads(send, encode, decode);
    const [a, b] = await Promise.allSettled([read([{ model: 'A' }]), read([{ model: 'Boom' }])]);
    expect(a).toEqual({ status: 'fulfilled', value: { ok: true, json: encode(['x']) } });
    expect(b.status).toBe('rejected');
  });
});
