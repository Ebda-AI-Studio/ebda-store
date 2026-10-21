import { applyTemplateFamily, getLook, type PageDefinition } from '@ebda/shared';
import type { ResolvedStore } from './store-resolver';

/**
 * The showroom keeps ONE superset home document; a demo store renders it through the current
 * look's section mix (Ruling B1-8): the look's order and design keys, and its own `lookTag`
 * sections (one hero per look, plan amendment C10). Pure: the stored document is never changed
 * and nothing is written, so a `?look=` preview stays a preview.
 *
 * Any non-demo store, a missing/unknown look, or a look without a mix gets the SAME object back,
 * so merchant stores never take this path.
 */
export function demoHomeDefinition(
  store: Pick<ResolvedStore, 'isDemo' | 'look'>,
  def: PageDefinition | undefined
): PageDefinition | undefined {
  if (!def || !store.isDemo) return def;
  const look = getLook(store.look);
  if (!look?.sections?.length) return def;
  return applyTemplateFamily(def, look.template, look);
}
