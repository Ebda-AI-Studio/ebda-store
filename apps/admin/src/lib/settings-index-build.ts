import type { RegistryEntry, SettingAccess } from './settings-registry';

/** One searchable entry of `settings-search-index.generated.json`: labels in BOTH languages. */
export interface IndexEntry {
  id: string;
  kind: 'page' | 'setting';
  route: string;
  query?: string;
  access: SettingAccess;
  feature?: string;
  en: string;
  ar: string;
  /** Label of the page the entry lives on (settings only; a page entry's own label is `en`/`ar`). */
  pageEn?: string;
  pageAr?: string;
  synEn: string;
  synAr: string;
}

type Messages = Record<string, unknown>;

export function messageAt(messages: Messages, path: string): string | undefined {
  const v = path.split('.').reduce<unknown>((o, k) => (o as Messages | undefined)?.[k], messages);
  return typeof v === 'string' ? v : undefined;
}

/**
 * Resolve the registry against the admin messages. Throws on a missing/empty label so a bad
 * `labelKey` can never produce a silent hole in search. Deterministic: same input, same output
 * (the committed JSON is compared to this by `tests/unit/settings-registry.test.ts`).
 */
export function buildSearchIndex(
  registry: readonly RegistryEntry[],
  en: Messages,
  ar: Messages
): IndexEntry[] {
  const pageByRoute = new Map(registry.filter(e => e.kind === 'page').map(e => [e.route, e]));
  return registry.map(e => {
    const labelEn = messageAt(en, e.labelKey);
    const labelAr = messageAt(ar, e.labelKey);
    if (!labelEn || !labelAr) {
      throw new Error(`settings registry: ${e.id} labelKey "${e.labelKey}" missing in en or ar`);
    }
    const out: IndexEntry = {
      id: e.id,
      kind: e.kind,
      route: e.route,
      access: e.access,
      en: labelEn,
      ar: labelAr,
      synEn: e.syn?.en ?? '',
      synAr: e.syn?.ar ?? '',
    };
    if (e.kind === 'setting' && e.query) out.query = e.query;
    if (e.feature) out.feature = e.feature;
    if (e.kind === 'setting') {
      const p = pageByRoute.get(e.route);
      if (!p) throw new Error(`settings registry: ${e.id} has no page entry for ${e.route}`);
      out.pageEn = messageAt(en, p.labelKey);
      out.pageAr = messageAt(ar, p.labelKey);
    }
    return out;
  });
}
