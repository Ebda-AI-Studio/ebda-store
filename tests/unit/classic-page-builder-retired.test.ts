/**
 * Task 12 (Ruling VE-6): the classic form page builder is gone. The old routes redirect to the
 * visual editor and keep the VE-16 deep link, the catalog hub lists ONE editor tab, and nothing
 * under apps/admin/src still names the classic builder.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const { redirect } = vi.hoisted(() => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));
vi.mock('next/navigation', () => ({ redirect }));

const STORE_DIR = path.resolve(__dirname, '../../apps/admin/src/app/stores/[id]');

async function landing(mod: string, search: Record<string, string | string[] | undefined> = {}) {
  const { default: Page } = await import(`../../apps/admin/src/app/stores/[id]/${mod}/page`);
  try {
    await Page({ params: Promise.resolve({ id: 'st1' }), searchParams: Promise.resolve(search) });
  } catch (e) {
    return (e as Error).message.replace(/^REDIRECT:/, '');
  }
  throw new Error('page did not redirect');
}

describe('the classic page builder redirects to the visual editor', () => {
  beforeEach(() => {
    redirect.mockClear();
  });

  for (const route of ['page-builder', 'hero', 'navigation', 'pages']) {
    it(`/${route} redirects to /builder`, async () => {
      expect(await landing(route)).toBe('/stores/st1/builder');
    });
    it(`/${route} keeps the deep link (select, block, field, page) and drops anything else`, async () => {
      const to = await landing(route, {
        select: 'hero',
        block: 'b1',
        field: 'title',
        page: 'product',
        evil: 'x',
      });
      expect(to).toBe('/stores/st1/builder?select=hero&block=b1&field=title&page=product');
    });
  }

  it('encodes the values and takes the first of a repeated param', async () => {
    expect(await landing('page-builder', { select: ['a b', 'c'] })).toBe(
      '/stores/st1/builder?select=a%20b'
    );
  });
});

describe('the editor is its own sidebar entry (T9), not a catalog tab', () => {
  it('the editor hub owns /builder and /page-builder, the catalog hub lists neither', async () => {
    const { HUBS, detectHub } = await import('../../apps/admin/src/components/admin-layout/hubs');
    const { buildStoreAdminNav } =
      await import('../../apps/admin/src/components/admin-layout/buildStoreAdminNav');
    const catalog = HUBS.find(h => h.key === 'catalog')!;
    const labels = new Proxy({}, { get: (_t, k) => String(k) }) as never;
    const tabs = catalog.buildTabs('st1', labels);
    expect(tabs.filter(t => /builder/.test(t.href))).toEqual([]);
    expect(catalog.urlPrefixes).not.toContain('/builder');
    expect(catalog.urlPrefixes).not.toContain('/page-builder');
    // an old /page-builder URL still highlights the editor entry (redirect target highlighting)
    expect(detectHub('/stores/st1/builder', 'st1')?.key).toBe('editor');
    expect(detectHub('/stores/st1/page-builder', 'st1')?.key).toBe('editor');
    expect(detectHub('/stores/st1/blog', 'st1')?.key).toBe('catalog');
    const items = buildStoreAdminNav('st1', labels);
    const editor = items.filter(i => i.href === '/stores/st1/builder');
    expect(editor).toHaveLength(1);
    expect(editor[0].hubKey).toBe('editor');
    expect(editor[0].name).toBe('editor');
  });
});

describe('the classic code is deleted', () => {
  it('page-builder holds only the redirect', () => {
    for (const f of ['CategoryLayoutButtons.tsx', 'ModeButton.tsx'])
      expect(existsSync(path.join(STORE_DIR, 'page-builder', f)), f).toBe(false);
    expect(readFileSync(path.join(STORE_DIR, 'page-builder/page.tsx'), 'utf8').length).toBeLessThan(
      2000
    );
  });
  it('the classic save helper and the unsaved-preview endpoint are gone', () => {
    const root = path.resolve(__dirname, '../..');
    expect(existsSync(path.join(root, 'apps/admin/src/lib/page-builder-save.ts'))).toBe(false);
    expect(
      readFileSync(path.join(root, 'apps/api/src/routes/store-layout.routes.ts'), 'utf8')
    ).not.toMatch(/['"]\/preview['"]/);
  });
});
