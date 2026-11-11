/**
 * Ruling NAME-PAIR-1 (repair apply, 2026-11-11): apply writes ONLY the product ids the operator passed after reading the
 * dry run, and never overwrites an English name the merchant typed (Latin text stamped 'human' in aiFieldSources).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  rows: [] as Array<{ id: string; name: string; nameAr: string | null; aiFieldSources: unknown }>,
  update: vi.fn(async () => ({})),
  send: vi.fn(async () => undefined),
}));

vi.mock('@api/lib/repo-factory', () => ({
  storeDb: async () => ({ product: { findMany: async () => h.rows } }),
  storeWriter: async () => ({ product: { update: h.update } }),
}));
vi.mock('@api/lib/inngest/send-after-commit', () => ({ sendEventAfterCommit: h.send }));

import { protectHumanEnglish, repairProductNames } from '@api/services/product-name-repair.service';

const SWAPPED = {
  id: 'p-swapped',
  name: 'خاتم ذهب',
  nameAr: 'Gold ring',
  aiFieldSources: { name: 'human' },
};
const AR_IN_EN = { id: 'p-ar', name: 'سلسلة فضة', nameAr: null, aiFieldSources: {} };
const PLACEHOLDER_HUMAN_EN = {
  id: 'p-ph',
  name: 'Pearl ring',
  nameAr: 'Pearl ring',
  aiFieldSources: { name: 'human', nameAr: 'ai' },
};

describe('repairProductNames apply', () => {
  beforeEach(() => {
    h.rows = [SWAPPED, AR_IN_EN, PLACEHOLDER_HUMAN_EN];
    h.update.mockClear();
    h.send.mockClear();
  });

  it('a dry run writes nothing and lists every bad pair', async () => {
    const r = await repairProductNames('s1', { apply: false });
    expect(r.items.map(i => i.id).sort()).toEqual(['p-ar', 'p-ph', 'p-swapped']);
    expect(h.update).not.toHaveBeenCalled();
  });

  it('apply writes only the listed ids; an id the scan did not find is reported, not written', async () => {
    const r = await repairProductNames('s1', { apply: true, productIds: ['p-ar', 'p-unknown'] });
    expect(r.applied).toEqual(['p-ar']);
    expect(r.skipped).toEqual([{ id: 'p-unknown', reason: 'not-repairable' }]);
    expect(h.update).toHaveBeenCalledTimes(1);
    expect(h.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'p-ar', storeId: 's1' } })
    );
  });

  it('apply with no ids writes nothing', async () => {
    const r = await repairProductNames('s1', { apply: true, productIds: [] });
    expect(r.applied).toEqual([]);
    expect(h.update).not.toHaveBeenCalled();
  });

  it('a merchant-typed English name is never overwritten (placeholder with a filled Arabic name: left alone)', async () => {
    const r = await repairProductNames('s1', { apply: true, productIds: ['p-ph'] });
    expect(r.applied).toEqual([]);
    expect(r.skipped).toEqual([{ id: 'p-ph', reason: 'merchant-english' }]);
    expect(h.update).not.toHaveBeenCalled();
  });

  it('swapped: the pair is put right; the English the merchant typed keeps its human stamp only if they typed it', async () => {
    await repairProductNames('s1', { apply: true, productIds: ['p-swapped'] });
    const data = (h.update.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect([data.name, data.nameAr]).toEqual(['Gold ring', 'خاتم ذهب']);
    expect(data.aiFieldSources).toMatchObject({ nameAr: 'human', name: 'ai' });
  });
});

describe('protectHumanEnglish', () => {
  const item = (after: { name: string; nameAr: string }) =>
    ({ id: 'x', name: '', nameAr: null, problem: 'placeholder', after }) as never;
  it('fills only an empty Arabic name next to a merchant English name', () => {
    expect(
      protectHumanEnglish(
        { name: 'Silver chain', nameAr: null, aiFieldSources: { name: 'human' } },
        item({ name: 'X', nameAr: 'سلسلة' })
      )
    ).toEqual({ name: 'Silver chain', nameAr: 'سلسلة' });
  });
  it('an AI English name may be rewritten', () => {
    expect(
      protectHumanEnglish(
        { name: 'Silver chain', nameAr: 'Silver chain', aiFieldSources: { name: 'ai' } },
        item({ name: 'Silver chain', nameAr: 'Silver chain' })
      )
    ).toEqual({ name: 'Silver chain', nameAr: 'Silver chain' });
  });
});
