import { composeStoreTheme, getLook } from '@ebda/shared';
import type { ResolvedStore } from './store-resolver';

import { parseDemoLook } from './demo-look-param';

export { DEMO_LOOK_PATTERN, DEMO_LOOK_HEADER, parseDemoLook } from './demo-look-param';

/** A look the showroom may show: shipped and reviewed ('built'), never merely 'designed'. */
export type IsLookBuilt = (lookId: string) => boolean;
export const defaultIsLookBuilt: IsLookBuilt = id => getLook(id)?.status === 'built';

/**
 * The store as it should render for a demo visitor previewing `rawLook`.
 *
 * Applied ONLY when `store.isDemo` and the look is built; otherwise the SAME object comes back,
 * so a non-demo store (or a designed look) renders exactly as it does without the param. A demo
 * preview goes through the one composition path every store uses (`composeStoreTheme`, with the
 * look's skin as the template) and returns a new object, so neither the per-instance store cache
 * nor Next's data cache (both hold the base store) ever sees the previewed look.
 *
 * The theme is recomposed from skin + look with NO merchant overrides: the demo store has none by
 * design (the seed writes an empty theme), and a showroom must show the look itself.
 */
export function applyDemoLook(
  store: ResolvedStore,
  rawLook: string | null | undefined,
  isBuilt: IsLookBuilt = defaultIsLookBuilt
): ResolvedStore {
  const lookId = parseDemoLook(rawLook);
  if (!lookId || !store.isDemo || !isBuilt(lookId)) return store;
  const look = getLook(lookId);
  if (!look) return store;
  return {
    ...store,
    template: look.skin,
    look: look.id,
    theme: composeStoreTheme({ template: look.skin, look: look.id, theme: {} }),
  };
}
