import { describe, it, expect } from 'vitest';
// @ts-expect-error plain .mjs script
import { parseArgs, drive } from '../../../scripts/ops/backfill-buyer-keys.mjs';

const mkIo = (init?: string) => {
  const files = new Map<string, string>(init ? [['c', init]] : []);
  return {
    files,
    io: {
      exists: (p: string) => files.has(p),
      read: (p: string) => files.get(p)!,
      write: (p: string, v: string) => void files.set(p, v),
      rm: (p: string) => void files.delete(p),
    },
  };
};
const page = (stores: unknown[], nextCursor: string | null) => ({
  success: true,
  data: {
    dryRun: true,
    stores,
    totals: { scanned: 2, keyed: 1, noPhone: 1, skippedStores: 0 },
    nextCursor,
  },
});

describe('backfill-buyer-keys script', () => {
  it('is a dry run by default and validates the budget', () => {
    expect(parseArgs([]).apply).toBe(false);
    expect(parseArgs(['--apply', '--budget', '100']).apply).toBe(true);
    expect(() => parseArgs(['--budget', '5000'])).toThrow('budget');
    expect(() => parseArgs(['--nope'])).toThrow('unknown');
  });
  it('follows nextCursor to the end, saves it between calls, sends dryRun:true, and removes the cursor file when done', async () => {
    const { io, files } = mkIo();
    const bodies: Array<Record<string, unknown>> = [];
    const answers = [page([], 'c1'), page([], 'c2'), page([], null)];
    const fetchFn = async (_u: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      if (files.has('c')) expect(files.get('c')).toBe(bodies.length === 2 ? 'c1' : 'c2');
      return { ok: true, status: 200, json: async () => answers.shift() };
    };
    const t = await drive({ ...parseArgs([]), cursorFile: 'c' }, 'tok', {
      fetchFn,
      io,
      log: () => {},
    });
    expect(t).toMatchObject({ calls: 3, scanned: 6, keyed: 3, noPhone: 3 });
    expect(bodies.map(b => [b.dryRun, b.cursor])).toEqual([
      [true, undefined],
      [true, 'c1'],
      [true, 'c2'],
    ]);
    expect(files.has('c')).toBe(false);
  });
  it('resumes from a saved cursor and sends dryRun:false with --apply', async () => {
    const { io } = mkIo('saved');
    let body: Record<string, unknown> = {};
    await drive({ ...parseArgs(['--apply']), cursorFile: 'c' }, 'tok', {
      fetchFn: async (_u: string, i: { body: string }) => (
        (body = JSON.parse(i.body)),
        { ok: true, status: 200, json: async () => page([], null) }
      ),
      io,
      log: () => {},
    });
    expect(body).toMatchObject({ dryRun: false, cursor: 'saved' });
  });
  it('stops loudly on an error and keeps the cursor for the retry', async () => {
    const { io, files } = mkIo('keep');
    await expect(
      drive({ ...parseArgs([]), cursorFile: 'c' }, 'tok', {
        fetchFn: async () => ({ ok: false, status: 503, json: async () => ({ success: false }) }),
        io,
        log: () => {},
      })
    ).rejects.toThrow('503');
    expect(files.get('c')).toBe('keep');
  });
});
