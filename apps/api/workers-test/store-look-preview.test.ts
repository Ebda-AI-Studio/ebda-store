/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, expect, it, beforeAll } from 'vitest';
import { getLook, layoutToDefinition, resolveLayoutSettings } from '@ebda/shared';
import { bootstrapMerchant, call, type Merchant } from './merchant-fixture';
import { doDeleteMany, doRead, doSetStoreFields, doStoreRecord } from './do-read';

// Ported from tests/integration/store-look-preview.test.ts (Postgres, ebda_app + tenant guard, express) to the built Worker + StoreDO, over HTTP:
// POST /stores/:id/look/preview writes nothing (no revision row, same look/template/theme) and returns the proposed draft + report + token;
// applying with the token writes exactly the proposed document; a page that moved since the preview (a new draft revision, or a theme change
// with no new revision) is a 409 DRAFT_MOVED with nothing written; another merchant's store, an unknown look and a stray body field are refused.
const LOOK = 'qamar.vitrine';
const HERO = {
  hero: {
    enabled: true,
    mode: 'slider',
    slides: [
      { image: 'https://m.ebda.app/a.jpg', headline: 'Fresh dates', headlineAr: 'تمور طازجة' },
    ],
  },
};
let n = 0;
/** A store on the legacy `dahab` skin with no look, no page revisions, and `theme` / `layoutSettings` as given (the original seeded exactly that). */
async function seed(
  tag: string,
  theme: Record<string, unknown> = {},
  layout?: Record<string, unknown>
) {
  const m = await bootstrapMerchant(`lkp-${tag}-${++n}`, { look: false });
  await doDeleteMany(m.storeId, 'StorePageRevision', { storeId: m.storeId });
  await doSetStoreFields(m.storeId, {
    template: 'dahab',
    look: null,
    theme,
    ...(layout ? { layoutSettings: layout } : {}),
  });
  return m;
}
const post = (m: Merchant, token: string, body: unknown, storeId = m.storeId) =>
  call(`/stores/${storeId}/look/preview`, { method: 'POST', token, body });
const put = (m: Merchant, token: string, body: unknown, storeId = m.storeId) =>
  call(`/stores/${storeId}/look`, { method: 'PUT', token, body });
const rows = (m: Merchant) =>
  doRead<{ rev: number; status: string; document: unknown }>(m.storeId, 'StorePageRevision', {
    where: { storeId: m.storeId, pageKey: 'home' },
    orderBy: { rev: 'asc' },
  });
const storeRow = (m: Merchant) => doStoreRecord(m.storeId, ['look', 'template', 'theme']);

describe('POST /stores/:id/look/preview on the Worker', () => {
  beforeAll(() => {
    expect(getLook(LOOK)?.status).toBe('built');
  });

  it('returns the proposed draft, a report that keeps the content, and a token, and writes nothing', async () => {
    const m = await seed('writes-nothing', { primaryColor: 'X' }, HERO);
    const before = { rows: await rows(m), store: await storeRow(m) };
    const res = await post(m, m.token, { lookId: LOOK, design: 'reset' });
    expect(res.status, res.text).toBe(200);
    expect(res.headers.get('cache-control')).toContain('no-store');
    const { draft, report, revisionToken, look, skinChange } = res.json.data;
    expect(look).toBe(LOOK);
    expect(typeof revisionToken).toBe('string');
    expect(draft.pageKey).toBe('home');
    const hero = draft.sections.find((s: { type: string }) => s.type === 'hero');
    expect(hero.blocks.map((b: { settings: { headline: string } }) => b.settings.headline)).toEqual(
      ['Fresh dates']
    );
    expect(report.contentChanged).toEqual([]);
    expect(report.keptContent.map((s: { type: string }) => s.type)).toContain('hero');
    expect(report.themeKeysReset).toEqual(['primaryColor']);
    expect(skinChange).toEqual({ from: 'dahab', to: getLook(LOOK)!.skin });
    expect(await rows(m)).toEqual(before.rows);
    expect(await storeRow(m)).toEqual(before.store);
  });

  it('applying with the token writes exactly the proposed document', async () => {
    const m = await seed('apply-equals', {}, HERO);
    const preview = await post(m, m.token, { lookId: LOOK, design: 'keep' });
    expect(preview.status, preview.text).toBe(200);
    const res = await put(m, m.token, {
      lookId: LOOK,
      design: 'keep',
      revisionToken: preview.json.data.revisionToken,
    });
    expect(res.status, res.text).toBe(200);
    const written = (await rows(m))
      .filter(r => r.status === 'draft' || r.status === 'published')
      .at(-1)!;
    expect(written.document).toEqual(preview.json.data.draft);
    expect((await storeRow(m)).look).toBe(LOOK);
  });

  it('a page that moved since the preview is refused with DRAFT_MOVED and nothing is written', async () => {
    const m = await seed('moved', {}, HERO);
    const preview = await post(m, m.token, { lookId: LOOK, design: 'keep' });
    // the merchant edits in another tab: a new draft revision
    const doc = layoutToDefinition(resolveLayoutSettings(HERO, 'dahab'));
    const saved = await call(`/admin/stores/${m.storeId}/builder/pages/home/draft`, {
      method: 'PUT',
      token: m.token,
      body: { baseRev: 0, definition: doc },
    });
    expect(saved.status, saved.text).toBe(200);
    const revsBefore = await rows(m);
    const res = await put(m, m.token, {
      lookId: LOOK,
      design: 'keep',
      revisionToken: preview.json.data.revisionToken,
    });
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe('DRAFT_MOVED');
    expect(await rows(m)).toEqual(revsBefore);
    expect((await storeRow(m)).look).toBeNull();
    const plain = await put(m, m.token, { lookId: LOOK, design: 'keep' }); // without a token the apply still works
    expect(plain.status, plain.text).toBe(200);
  });

  it('a theme or layout change with no new revision also moves the token (DRAFT_MOVED)', async () => {
    const m = await seed('moved-theme', {}, HERO);
    const preview = await post(m, m.token, { lookId: LOOK, design: 'keep' });
    await doSetStoreFields(m.storeId, { theme: { primaryColor: '#123456' } });
    const res = await put(m, m.token, {
      lookId: LOOK,
      design: 'keep',
      revisionToken: preview.json.data.revisionToken,
    });
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe('DRAFT_MOVED');
    expect((await storeRow(m)).look).toBeNull();
  });

  it("refuses another merchant's store, an unknown look and a look that is not built", async () => {
    const a = await seed('owner-a', {}, HERO);
    const b = await seed('owner-b', {}, HERO);
    const foreign = await post(a, b.token, { lookId: LOOK, design: 'keep' });
    expect([403, 404]).toContain(foreign.status);
    expect((await post(a, a.token, { lookId: 'nope.nope', design: 'keep' })).status).toBe(400);
    const unbuilt = ['lamma.table', 'dahab.worn', 'jasmine.clinic']
      .map(id => getLook(id))
      .find(l => l && l.status !== 'built');
    if (unbuilt) {
      const res = await post(a, a.token, { lookId: unbuilt.id, design: 'keep' });
      expect(res.status).toBe(400);
      expect(res.json.error.code).toBe('LOOK_NOT_AVAILABLE');
    }
    expect(
      (await post(a, a.token, { lookId: LOOK, design: 'keep', revisionToken: 'x' })).status
    ).toBe(400);
    expect((await storeRow(a)).look).toBeNull(); // none of the refusals changed A
  });
});
