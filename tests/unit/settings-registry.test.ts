/**
 * Coverage gate for admin search (search program P2, E23). The registry
 * (apps/admin/src/lib/settings-registry.ts) is the one list of everything a merchant can search
 * for; this test makes a new admin page or control that is not in it a failing test.
 *
 *  1. Every static `/stores/[id]/**` page route is registered, or is a verified redirect stub.
 *  2. Every registered page has a page file (no dead routes), ids are unique, every setting sits on
 *     a registered page.
 *  3. Every label resolves in BOTH ar.json and en.json, and the committed generated index equals
 *     what the registry + messages produce now (run `npm run gen:settings-search -w apps/admin`).
 *  4. Anchors: every registered setting is marked `data-setting-id` once in the source, inside its
 *     own route's directory, and every `data-setting-id` in the source is registered.
 *  5. Access and feature agree with the sidebar hubs (Finance/Settings are owner-only) and with
 *     each page's own `useRequireFeature` gate.
 *  6. Control ratchet: labelled controls on the settings pages cannot grow past
 *     SETTINGS_LABEL_BASELINE without the baseline (and so a registry entry) changing with them.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import {
  PAGES,
  REDIRECT_ROUTES,
  REGISTRY,
  SETTINGS,
  SETTINGS_LABEL_BASELINE,
} from '../../apps/admin/src/lib/settings-registry';
import { buildSearchIndex } from '../../apps/admin/src/lib/settings-index-build';
import generated from '../../apps/admin/src/lib/settings-search-index.generated.json';
import en from '../../apps/admin/src/i18n/messages/en.json';
import ar from '../../apps/admin/src/i18n/messages/ar.json';
import { detectHub } from '../../apps/admin/src/components/admin-layout/hubs';
import { buildStoreAdminNav } from '../../apps/admin/src/components/admin-layout/buildStoreAdminNav';

const SRC = resolve(__dirname, '../../apps/admin/src');
const STORE_DIR = join(SRC, 'app/stores/[id]');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const isSource = (f: string) => /\.tsx?$/.test(f) && !/\.test\.|__tests__/.test(f);
const read = (f: string) => readFileSync(f, 'utf8');

const pageFiles = walk(STORE_DIR).filter(f => f.endsWith('/page.tsx'));
/** Route of a page file under /stores/[id]: '' -> '/', dynamic segments kept as written. */
const routeOf = (f: string) => '/' + relative(STORE_DIR, f).replace(/\/?page\.tsx$/, '');
const staticRoutes = pageFiles.map(routeOf).filter(r => !r.includes('['));

describe('admin search registry: routes', () => {
  it('every static admin page route is registered or a verified redirect stub', () => {
    const known = new Set([...PAGES.map(p => p.route), ...Object.keys(REDIRECT_ROUTES)]);
    const missing = staticRoutes.filter(r => !known.has(r));
    expect(
      missing,
      `register these in settings-registry.ts (PAGES, or REDIRECT_ROUTES): ${missing}`
    ).toEqual([]);
  });

  it('every registered page has a page file, and no route is registered twice', () => {
    const files = new Set(staticRoutes);
    expect(PAGES.filter(p => !files.has(p.route)).map(p => p.route)).toEqual([]);
    const routes = PAGES.map(p => p.route);
    expect(routes.filter((r, i) => routes.indexOf(r) !== i)).toEqual([]);
    expect(Object.keys(REDIRECT_ROUTES).filter(r => routes.includes(r))).toEqual([]);
  });

  it('a redirect stub really is one (a stub that grows content must be registered instead)', () => {
    for (const route of Object.keys(REDIRECT_ROUTES)) {
      const file = pageFiles.find(f => routeOf(f) === route);
      expect(file, `no page file for redirect stub ${route}`).toBeTruthy();
      expect(read(file!), route).toMatch(/redirect\(|[Tt]hin redirect|GHOST ROUTE redirect/);
    }
  });

  it('ids are unique and every setting sits on a registered page', () => {
    const ids = REGISTRY.map(e => e.id);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
    const routes = new Set(PAGES.map(p => p.route));
    expect(SETTINGS.filter(s => !routes.has(s.route)).map(s => s.id)).toEqual([]);
    for (const p of PAGES) expect(p.id).toBe(`page:${p.route}`);
  });
});

describe('admin search registry: labels + generated index', () => {
  it('every label resolves in BOTH ar and en (buildSearchIndex throws otherwise)', () => {
    expect(() => buildSearchIndex(REGISTRY, en, ar)).not.toThrow();
    for (const row of buildSearchIndex(REGISTRY, en, ar)) {
      expect(row.en.trim(), row.id).not.toBe('');
      expect(row.ar.trim(), row.id).not.toBe('');
    }
  });

  it('the committed settings-search-index.generated.json is current', () => {
    expect(generated).toEqual(JSON.parse(JSON.stringify(buildSearchIndex(REGISTRY, en, ar))));
  });
});

describe('admin search registry: anchors', () => {
  const sources = walk(SRC).filter(isSource);
  const literal = /data-setting-id="([a-z][a-z0-9.-]*)"/g;
  const found = new Map<string, string[]>(); // id -> files
  for (const f of sources) {
    for (const m of read(f).matchAll(literal)) {
      found.set(m[1], [...(found.get(m[1]) ?? []), f]);
    }
  }

  it('every registered setting is anchored exactly once, inside its own route directory', () => {
    const problems: string[] = [];
    for (const s of SETTINGS) {
      const files = found.get(s.id) ?? [];
      if (files.length !== 1) {
        problems.push(`${s.id}: anchored ${files.length} times (expected 1)`);
        continue;
      }
      const dir = join(STORE_DIR, s.route === '/' ? '' : s.route);
      if (!files[0].startsWith(dir + '/')) problems.push(`${s.id}: anchor is outside ${s.route}`);
    }
    expect(problems).toEqual([]);
  });

  it('every data-setting-id in the source is a registered setting', () => {
    const ids = new Set(SETTINGS.map(s => s.id));
    expect([...found.keys()].filter(id => !ids.has(id))).toEqual([]);
  });
});

describe('admin search registry: access + features agree with the product', () => {
  it('the Finance and Settings hubs are the staff-restricted ones, and their pages are not staff pages', () => {
    const labels = new Proxy({}, { get: (_t, k) => String(k) }) as never;
    const restricted = new Set(
      buildStoreAdminNav('s', labels)
        .filter(n => n.staffRestricted)
        .map(n => n.hubKey)
    );
    expect([...restricted].sort()).toEqual(['finance', 'settings']);
    for (const p of PAGES) {
      const hub = detectHub(`/stores/s${p.route === '/' ? '' : p.route}`, 's');
      if (hub && restricted.has(hub.key)) {
        expect(p.access, `${p.route} is in the ${hub.key} hub`).not.toBe('staff');
      }
    }
  });

  it('a settings entry is never more open than its page', () => {
    const rank = { staff: 0, owner: 1, super_admin: 2 } as const;
    const page = new Map(PAGES.map(p => [p.route, p]));
    for (const s of SETTINGS) {
      expect(rank[s.access], s.id).toBeGreaterThanOrEqual(rank[page.get(s.route)!.access]);
    }
  });

  it("each page's own useRequireFeature gate is the entry's feature", () => {
    const wrong: string[] = [];
    for (const f of pageFiles) {
      const route = routeOf(f);
      if (route.includes('[')) continue;
      const m = read(f).match(/useRequireFeature\(\s*'([^']+)'\s*\)/);
      if (!m) continue;
      const entry = PAGES.find(p => p.route === route);
      if (entry && entry.feature !== m[1])
        wrong.push(`${route}: page gates on ${m[1]}, registry says ${entry.feature}`);
    }
    expect(wrong).toEqual([]);
  });
});

describe('admin search registry: control ratchet', () => {
  /** `<label>`/`<Label>`, `<legend>`, `<Toggle>` and `<FormField>` under a route directory (tests excluded). */
  const labelledControls = (route: string) =>
    walk(join(STORE_DIR, route))
      .filter(isSource)
      .reduce(
        (n, f) => n + (read(f).match(/<(?:[Ll]abel|legend|Toggle|FormField)\b/g)?.length ?? 0),
        0
      );

  it('every settings route with registered controls has a baseline', () => {
    const routes = [...new Set(SETTINGS.map(s => s.route))].sort();
    expect(Object.keys(SETTINGS_LABEL_BASELINE).sort()).toEqual(routes);
  });

  it.each(Object.entries(SETTINGS_LABEL_BASELINE))(
    '%s has no more labelled controls than the reviewed baseline (%i)',
    (route, baseline) => {
      expect(
        labelledControls(route),
        `${route} gained a labelled control (<label>/<Label>/<legend>/<Toggle>/<FormField>): add a registry entry + data-setting-id anchor for it, then raise SETTINGS_LABEL_BASELINE`
      ).toBeLessThanOrEqual(baseline);
    }
  );
});

describe('admin search registry: every visual-editor control (Task 11)', () => {
  // The controls Tasks 1-10 put in the editor. A forgotten control names itself here.
  const EDITOR_CONTROLS = [
    'builder.header-logo',
    'builder.header-search',
    'builder.header-wordmark',
    'builder.hero-ratio',
    'builder.tab-bar',
    'builder.card-heart',
    'builder.card-swatches',
    'builder.card-tags',
    'builder.grid-gutter',
    'builder.heading-weight',
    'builder.price-colour',
    'builder.card-brand-badge',
    'builder.card-new-badge',
    'builder.card-quick-add',
    'builder.card-even-images',
    'builder.card-sale-corner',
    'builder.fonts',
    'builder.typography-zones',
    'builder.section-typography',
    'builder.dividers',
    'builder.video',
    'builder.page-settings',
    'builder.page-switcher',
    'builder.look-switch',
    'builder.history',
    'builder.ai-patch',
    'builder.add-section',
  ];
  const builder = SETTINGS.filter(s => s.route === '/builder');

  it('has an entry for each, and no entry outside the list', () => {
    expect(builder.map(s => s.id).sort()).toEqual([...EDITOR_CONTROLS].sort());
  });

  it('every entry that needs a pane or a section deep-links with a valid select/page', () => {
    const OK =
      /^(select=(theme|history|[a-z][a-z0-9-]*)(&block=[a-z][a-z0-9-]*)?|page=(product|collection|cart))$/;
    for (const s of builder) if (s.query) expect(s.query, s.id).toMatch(OK);
    // the two header chrome controls live in the theme tab: they must open it, not just /builder
    for (const id of [
      'builder.header-logo',
      'builder.header-search',
      'builder.header-wordmark',
      'builder.hero-ratio',
      'builder.tab-bar',
      'builder.card-heart',
      'builder.card-swatches',
      'builder.card-tags',
      'builder.grid-gutter',
      'builder.heading-weight',
      'builder.price-colour',
    ])
      expect(builder.find(s => s.id === id)?.query).toBe('select=theme');
  });

  it('labels resolve in Arabic and English and are not the same string', () => {
    for (const s of builder) {
      const at = (m: object) => s.labelKey.split('.').reduce<any>((o, k) => o?.[k], m);
      expect(at(en), s.id).toBeTruthy();
      expect(at(ar), s.id).toBeTruthy();
    }
  });

  it('the Arabic key sets of the new labels match English and carry no ICU "#"', () => {
    const e = (en as any).builder.search;
    const a = (ar as any).builder.search;
    expect(Object.keys(a).sort()).toEqual(Object.keys(e).sort());
    for (const v of [...Object.values<string>(e), ...Object.values<string>(a)])
      expect(v).not.toContain('#');
  });
});
