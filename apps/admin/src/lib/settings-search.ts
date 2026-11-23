import { normalizeArabicSearch as normalize } from '@ebda/shared';
import type { PaletteItem } from '../components/admin-layout/buildPaletteItems';
import type { IndexEntry } from './settings-index-build';
import index from './settings-search-index.generated.json';

/**
 * Admin settings + page search (search program P2, E23). Pure functions over the generated index
 * (see settings-registry.ts): no React, no fetch, so the ⌘K palette, the Settings search box and
 * the tests all rank and gate identically.
 */

const ENTRIES = index as IndexEntry[];

const KNOWN_IDS = new Set(ENTRIES.map(e => e.id));

/** True for an id the registry knows: `?setting=` is untrusted input and only these are acted on. */
export function isKnownSettingId(id: string | null | undefined): id is string {
  return typeof id === 'string' && KNOWN_IDS.has(id);
}

export type SearchLocale = 'ar' | 'en';

export interface SearchContext {
  /** The signed-in user's role; anything but super_admin / store_admin / staff sees nothing. */
  role: string | undefined;
  isFeatureEnabled: (key: string) => boolean;
  /** While the feature map loads a feature-keyed entry stays hidden (like the hub tabs). */
  featuresLoading: boolean;
}

/** super_admin sees everything; store_admin staff+owner pages; staff only the staff pages. */
export function canSeeEntry(e: IndexEntry, ctx: SearchContext): boolean {
  const roleOk =
    ctx.role === 'super_admin' ||
    (ctx.role === 'store_admin' && e.access !== 'super_admin') ||
    (ctx.role === 'staff' && e.access === 'staff');
  if (!roleOk) return false;
  if (e.feature && (ctx.featuresLoading || !ctx.isFeatureEnabled(e.feature))) return false;
  return true;
}

/** Where the entry lives: the page, plus `?tab=` and `?setting=` for a control. */
export function entryHref(storeId: string, e: IndexEntry): string {
  const base = `/stores/${storeId}${e.route === '/' ? '' : e.route}`;
  if (e.kind === 'page') return base;
  // The visual editor reads `field=` (and `select=` / `page=` from the entry's query), not `?setting=`.
  const target = e.route === '/builder' ? 'field' : 'setting';
  const params = [e.query, `${target}=${encodeURIComponent(e.id)}`].filter(Boolean).join('&');
  return `${base}?${params}`;
}

export function entryLabel(e: IndexEntry, locale: SearchLocale): string {
  return locale === 'ar' ? e.ar : e.en;
}

function haystack(e: IndexEntry): string {
  return normalize(`${e.en} ${e.ar} ${e.synEn} ${e.synAr} ${e.pageEn ?? ''} ${e.pageAr ?? ''}`);
}

const HAY = new Map<string, string>();
function hayOf(e: IndexEntry): string {
  let h = HAY.get(e.id);
  if (h === undefined) {
    h = haystack(e);
    HAY.set(e.id, h);
  }
  return h;
}

/** A term matches as typed, or without a leading Arabic article ("الشحن" finds "شحن"). */
function termMatches(hay: string, term: string): boolean {
  if (hay.includes(term)) return true;
  return term.length > 3 && term.startsWith('ال') && hay.includes(term.slice(2));
}

export interface RegistryHit {
  entry: IndexEntry;
  /** -1 = the entry's PRIMARY keyword (first synonym word), 0 = in its own label, 1 = in its page's label, 2 = only in synonyms. Lower is better. */
  rank: number;
}

/** The first synonym word in each language is the entry's primary keyword ("seo" for the SEO page). */
function primaryKeywords(e: IndexEntry): string[] {
  return [e.synEn, e.synAr]
    .map(syn => normalize(syn ?? '').split(' ')[0])
    .filter((w): w is string => !!w);
}

/**
 * Entries every word of `query` (Arabic-folded, any language) matches, best first: label hits
 * before page-name hits before synonym hits, pages before the settings on them, then registry
 * order. A blank query matches nothing (the palette lists navigation itself for that).
 */
export function searchRegistry(query: string, ctx: SearchContext, limit = 12): RegistryHit[] {
  const terms = normalize(query).split(' ').filter(Boolean);
  if (terms.length === 0) return [];
  const hits: RegistryHit[] = [];
  ENTRIES.forEach(e => {
    if (!canSeeEntry(e, ctx)) return;
    const hay = hayOf(e);
    if (!terms.every(t => termMatches(hay, t))) return;
    const own = normalize(`${e.en} ${e.ar}`);
    const withPage = normalize(`${e.en} ${e.ar} ${e.pageEn ?? ''} ${e.pageAr ?? ''}`);
    // Typing exactly an entry's primary keyword ("SEO", "سيو") puts it above incidental synonym hits.
    const primary = primaryKeywords(e);
    const rank =
      e.kind === 'page' && terms.every(t => primary.includes(t))
        ? -1
        : terms.every(t => termMatches(own, t))
          ? 0
          : terms.every(t => termMatches(withPage, t))
            ? 1
            : 2;
    hits.push({ entry: e, rank });
  });
  const order = new Map(ENTRIES.map((e, i) => [e.id, i]));
  return hits
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        Number(a.entry.kind === 'setting') - Number(b.entry.kind === 'setting') ||
        order.get(a.entry.id)! - order.get(b.entry.id)!
    )
    .slice(0, limit);
}

/** The registry as ⌘K palette items for the visible entries (labels in the UI language). */
export function registryPaletteItems(
  storeId: string,
  ctx: SearchContext,
  locale: SearchLocale
): PaletteItem[] {
  return ENTRIES.filter(e => canSeeEntry(e, ctx)).map(e => ({
    name: entryLabel(e, locale),
    href: entryHref(storeId, e),
    group: e.kind === 'setting' ? (locale === 'ar' ? e.pageAr : e.pageEn) : undefined,
    kind: e.kind,
    // Both languages + everyday words: the palette folds and matches them all.
    keywords: `${e.en} ${e.ar} ${e.synEn} ${e.synAr} ${e.pageEn ?? ''} ${e.pageAr ?? ''}`,
  }));
}

const pathOf = (href: string) => href.split('?')[0];

/**
 * Combine the palette's own navigation items with the registry: a registry PAGE whose path the
 * palette already lists lends its synonyms to that item (so "الشحن" finds the Shipping tab with its
 * everyday words); every other registry entry is added. Palette items keep their order and icons.
 */
export function mergeRegistryIntoPalette(
  existing: PaletteItem[],
  fromRegistry: PaletteItem[]
): PaletteItem[] {
  const byPath = new Map(existing.map(i => [pathOf(i.href), i]));
  const extra: PaletteItem[] = [];
  const lent = new Map<string, string>();
  for (const r of fromRegistry) {
    const hit = r.kind === 'page' ? byPath.get(pathOf(r.href)) : undefined;
    if (hit) lent.set(hit.href, [lent.get(hit.href), r.keywords].filter(Boolean).join(' '));
    else extra.push(r);
  }
  return [
    ...existing.map(i =>
      lent.has(i.href)
        ? { ...i, keywords: [i.keywords, lent.get(i.href)].filter(Boolean).join(' ') }
        : i
    ),
    ...extra,
  ];
}
