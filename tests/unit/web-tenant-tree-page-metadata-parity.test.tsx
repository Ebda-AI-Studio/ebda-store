/**
 * Page-level metadata parity, tenant tree vs legacy tree (issue 2418).
 *
 * Flipping tenant routing moves a page from `app/<route>/page.tsx` to
 * `app/tenant-store/[tenant]/[locale]/<route>/page.tsx`. The layout-level
 * parity proof (web-tenant-tree-store-chrome-render.test.tsx) cannot see a page
 * that drops a field: the legacy categories page set a store-aware canonical and
 * its tenant twin did not. This resolves BOTH pages' metadata for the same store
 * and requires them to match, per route, so the next tenant page added cannot
 * silently drop a canonical, title, description or robots rule.
 */
import { describe, it, expect, vi } from 'vitest';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const WEB = join(__dirname, '../../apps/web/src');
const TENANT_DIR = join(WEB, 'app/tenant-store/[tenant]/[locale]');

const STORE = {
  id: 'store-1',
  name: 'Demo Shop',
  slug: 'demo-shop',
  domain: 'demo-shop.example',
  status: 'active',
  description: 'Nuts and dates',
  theme: {},
  settings: { defaultLanguage: 'ar' },
  enabledFeatures: [],
  transientResolveFailure: false,
};

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers({ host: 'demo-shop.example', 'x-is-platform': '0' }),
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('notFound');
  },
  redirect: () => {
    throw new Error('redirect');
  },
}));
vi.mock('../../apps/web/src/lib/store-resolver', () => ({
  getStore: async () => STORE,
  getStoreOrNotFound: async () => STORE,
  getStoreByTenantParam: async () => STORE,
  isResolvedStore: (s: { id: string; transientResolveFailure?: boolean }) =>
    !s.transientResolveFailure && s.id !== 'demo',
}));
vi.mock('../../apps/web/src/lib/preview-draft', () => ({ getPreviewDraftToken: async () => null }));

type PageModule = {
  metadata?: unknown;
  generateMetadata?: (props: unknown) => Promise<unknown>;
};

async function resolveMetadata(mod: PageModule, params: Record<string, string>) {
  if (mod.generateMetadata) {
    return mod.generateMetadata({
      params: Promise.resolve(params),
      searchParams: Promise.resolve({}),
    });
  }
  return mod.metadata;
}

/** Tenant routes that have a legacy flat twin at `app/<route>/page.tsx`. */
const ROUTES = readdirSync(TENANT_DIR, { withFileTypes: true })
  .filter(d => d.isDirectory() && !d.name.startsWith('['))
  .map(d => d.name)
  .filter(r => existsSync(join(WEB, 'app', r, 'page.tsx')))
  .sort();

describe('tenant-tree page metadata equals its legacy twin', () => {
  it('finds the routes (the loop below is not vacuous)', () => {
    expect(ROUTES).toEqual(expect.arrayContaining(['about', 'categories', 'faq', 'products']));
  });

  for (const route of ROUTES) {
    it(`/${route}`, async () => {
      const legacy = (await import(`${WEB}/app/${route}/page`)) as PageModule;
      const tenant = (await import(`${TENANT_DIR}/${route}/page`)) as PageModule;
      const off = await resolveMetadata(legacy, {});
      // The legacy twin resolves the page language from the store default (ar here); the tenant route reads it from the URL.
      const on = await resolveMetadata(tenant, { tenant: 'demo-shop.example', locale: 'ar' });
      expect(on).toEqual(off);
    });
  }

  it('the home page canonical matches the legacy home', async () => {
    const legacy = (await import(`${WEB}/app/page`)) as PageModule;
    const tenant = (await import(`${TENANT_DIR}/page`)) as PageModule;
    const off = (await resolveMetadata(legacy, {})) as { alternates?: unknown } | undefined;
    const on = (await resolveMetadata(tenant, { tenant: 'demo-shop.example', locale: 'en' })) as
      | { alternates?: unknown }
      | undefined;
    expect(on?.alternates).toEqual(off?.alternates);
  });
});
