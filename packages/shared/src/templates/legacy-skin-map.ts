/**
 * The five inherited Force skins are deleted (Ruling SKIN-DEL-1..8). Their names still exist in
 * the wild: `stores.template` in Postgres (the enum keeps the values, SKIN-DEL-8), saved page
 * documents, `store_page_revisions`, theme JSON and backups. This file is the ONLY place in the
 * repo allowed to carry the five names as strings (the allowlist of
 * tests/unit/no-retired-skin-strings.test.ts).
 *
 *  - READERS call `normalizeLegacyTemplate()`: any old value parses forever and maps to the
 *    template of its nearest Ebda look, at read time, with no database write.
 *  - WRITERS are strict: they accept only `EBDA_TEMPLATES` and reject a retired value
 *    (`isRetiredTemplate`).
 */
import type { TemplateId } from '../types/store-theme';
import type { LookId } from '../looks/types';
import { getLook } from '../looks/registry';

/** The five retired Force skins, kept only so old persisted values still parse. */
export const RETIRED_TEMPLATES = ['modern', 'classic', 'minimal', 'bold', 'elegant'] as const;
export type RetiredTemplate = (typeof RETIRED_TEMPLATES)[number];

/** Every live template, in registry order. A writer accepts exactly these. */
export const EBDA_TEMPLATES = ['dahab', 'qamar', 'souq', 'jasmine', 'lamma'] as const;

// Compile-time proof that EBDA_TEMPLATES and TemplateId are the same set (either direction fails).
type _Exhaustive = TemplateId extends (typeof EBDA_TEMPLATES)[number]
  ? (typeof EBDA_TEMPLATES)[number] extends TemplateId
    ? true
    : never
  : never;
const _exhaustive: _Exhaustive = true;
void _exhaustive;

/** What an unknown or empty persisted template resolves to (the column default). */
export const DEFAULT_EBDA_TEMPLATE: TemplateId = 'qamar';

export function isRetiredTemplate(v: unknown): v is RetiredTemplate {
  return typeof v === 'string' && (RETIRED_TEMPLATES as readonly string[]).includes(v);
}

export function isEbdaTemplate(v: unknown): v is TemplateId {
  return typeof v === 'string' && (EBDA_TEMPLATES as readonly string[]).includes(v);
}

/** Ruling SKIN-DEL-1: the fixed fallback when a mapped look is not built. */
const FALLBACK_LOOK: LookId = 'qamar.atelier';

/** Ruling SKIN-DEL-1: each retired skin to the nearest built Ebda look, by character. */
const RETIRED_SKIN_LOOK: Record<RetiredTemplate, LookId> = {
  modern: 'souq.catalogue',
  elegant: 'qamar.atelier',
  classic: 'dahab.worn',
  minimal: 'souq.showroom',
  bold: 'qamar.lookbook',
};

/**
 * Pure. The look a retired skin maps to (Ruling SKIN-DEL-1). A target that is not `built`
 * (or is missing from the registry) uses the fixed fallback. Never depends on a store slug.
 */
export function mapRetiredSkin(
  skin: RetiredTemplate,
  opts: { isBuilt?: (lookId: LookId) => boolean } = {}
): LookId {
  const isBuilt = opts.isBuilt ?? ((id: LookId) => getLook(id)?.status === 'built');
  const target = RETIRED_SKIN_LOOK[skin];
  return isBuilt(target) ? target : FALLBACK_LOOK;
}

/**
 * The READ-time normalizer. A live template passes through; a retired one returns the template
 * (skin) of its mapped look; null, undefined, '' and anything unknown return the default Ebda
 * template. Never throws, never writes.
 */
export function normalizeLegacyTemplate(v: unknown): TemplateId {
  if (isEbdaTemplate(v)) return v;
  if (isRetiredTemplate(v)) {
    const look = getLook(mapRetiredSkin(v));
    if (look && isEbdaTemplate(look.skin)) return look.skin;
  }
  return DEFAULT_EBDA_TEMPLATE;
}

/**
 * Maps a retired name to its Ebda template and leaves every other value (live or unknown)
 * untouched, for the lookups whose "unknown id" behaviour is deliberate (the bare global default).
 */
export function mapRetiredTemplate(v: string): string {
  return isRetiredTemplate(v) ? normalizeLegacyTemplate(v) : v;
}
