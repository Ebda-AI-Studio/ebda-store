/**
 * The storefront's top-to-bottom flow, for the admin (CLAUDE.md UI rule 5: the admin mirrors the
 * storefront, never alphabetical, never grouped by control type).
 *
 * `flowOrder` is the home's section types in the order the storefront draws them for a store's
 * template and look: the look's section mix when it has one (what a look switch lays out), else the
 * skin's default layout. Pure. The add-section picker lists these first, then everything else.
 */
import {
  getLook,
  getSectionDefinition,
  layoutToDefinition,
  resolveLayoutSettings,
  normalizeLegacyTemplate,
} from '@ebda/shared';

const unique = (xs: readonly string[]) => [...new Set(xs)];

export function flowOrder(
  template: string | null | undefined,
  lookId: string | null | undefined
): string[] {
  const mix = getLook(lookId)?.sections;
  const types =
    mix && mix.length > 0
      ? mix.map(s => s.type)
      : layoutToDefinition(
          resolveLayoutSettings({}, normalizeLegacyTemplate(template))
        ).sections.map(n => n.type);
  return unique(types.filter(t => getSectionDefinition(t)?.group === 'template'));
}

/** `types` split into the store's own (in flow order) and the rest (in the order given). */
export function orderByFlow(
  types: readonly string[],
  flow: readonly string[]
): { first: string[]; more: string[] } {
  const have = new Set(types);
  const first = flow.filter(t => have.has(t));
  const own = new Set(first);
  return { first, more: types.filter(t => !own.has(t)) };
}
