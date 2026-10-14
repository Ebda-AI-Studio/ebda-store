/**
 * The admin page-builder Save, wired to the visual builder's draft/publish API
 * (Phase 1): draft with the loaded rev, then publish the draft's rev; 409 is
 * surfaced as a conflict (never retried blindly); a publish failure after a
 * saved draft hands back the draft's rev so a retry publishes it; an API
 * without builder routes yields `null` so Save falls back to the legacy PUT.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { layoutToDefinition, resolveLayoutSettings } from '@ebda/shared';

const api = vi.hoisted(() => ({ apiGet: vi.fn(), apiPut: vi.fn(), apiPost: vi.fn() }));
vi.mock('../../apps/admin/src/lib/api', () => api);

const { saveLayoutAsPage, loadPageRev } =
  await import('../../apps/admin/src/lib/page-builder-save');

const LAYOUT = resolveLayoutSettings({ newArrivals: { enabled: false, limit: 4 } }, 'modern');
const BASE = '/api/v1/admin/stores/s1/builder/pages/home';

describe('admin page-builder save via draft + publish', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps document-only sections (image-text) the new builder added', async () => {
    const { reduceDocument } = await import('@ebda/shared');
    const withImage = reduceDocument(layoutToDefinition(LAYOUT), {
      type: 'addSection',
      list: 'template',
      sectionType: 'image-text',
      presetIndex: 0,
      index: 1,
    }).doc;
    api.apiGet.mockResolvedValue({ data: { definition: withImage, rev: 7 }, error: null });
    api.apiPut.mockResolvedValue({ data: { rev: 8 }, error: null });
    api.apiPost.mockResolvedValue({ data: { rev: 8 }, error: null });
    await saveLayoutAsPage('s1', LAYOUT, 7);
    const sent = api.apiPut.mock.calls[0][1].definition;
    expect(sent.sections.map((s: { id: string }) => s.id)).toEqual(
      withImage.sections.map(s => s.id)
    );
  });

  it('drafts the adapter document at the loaded rev, then publishes the draft rev', async () => {
    api.apiGet.mockResolvedValue({ data: null, error: null });
    api.apiPut.mockResolvedValue({ data: { rev: 8 }, error: null });
    api.apiPost.mockResolvedValue({ data: { rev: 8 }, error: null });
    expect(await saveLayoutAsPage('s1', LAYOUT, 7)).toEqual({ ok: true, rev: 8 });
    expect(api.apiPut).toHaveBeenCalledWith(`${BASE}/draft`, {
      baseRev: 7,
      definition: layoutToDefinition(LAYOUT),
    });
    expect(api.apiPost).toHaveBeenCalledWith(`${BASE}/publish`, { baseRev: 8 });
  });

  it('a 409 on the draft is a conflict and publishes nothing', async () => {
    api.apiPut.mockResolvedValue({
      data: null,
      error: { code: 'REV_CONFLICT', message: 'x', status: 409 },
    });
    const r = await saveLayoutAsPage('s1', LAYOUT, 7);
    expect(r).toMatchObject({ ok: false, conflict: true, rev: 7 });
    expect(api.apiPost).not.toHaveBeenCalled();
  });

  it('a publish failure after a saved draft returns the draft rev for the retry', async () => {
    api.apiPut.mockResolvedValue({ data: { rev: 8 }, error: null });
    api.apiPost.mockResolvedValue({
      data: null,
      error: { code: 'SERVER_ERROR', message: 'x', status: 500 },
    });
    expect(await saveLayoutAsPage('s1', LAYOUT, 7)).toMatchObject({
      ok: false,
      conflict: false,
      rev: 8,
    });
  });

  it('an API without the builder routes -> null (legacy PUT fallback)', async () => {
    api.apiGet.mockResolvedValue({
      data: null,
      error: { code: 'NOT_FOUND', message: 'x', status: 404 },
    });
    expect(await loadPageRev('s1')).toBeNull();
    api.apiGet.mockResolvedValue({ data: { rev: 0 }, error: null });
    expect(await loadPageRev('s1')).toBe(0);
  });

  it('the page-builder page saves through it and keeps the legacy PUT only as the fallback', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(
      new URL('../../apps/admin/src/app/stores/[id]/page-builder/page.tsx', import.meta.url),
      'utf8'
    );
    expect(src).toMatch(/saveLayoutAsPage\(storeId, current, pageRev\)/);
    expect(src).toMatch(
      /if \(pageRev === null\) return apiPut\(`\/api\/v1\/admin\/stores\/\$\{storeId\}\/layout`/
    );
    expect(src).toMatch(/toastError\(t\('saveConflict'\)\)/);
  });
});
