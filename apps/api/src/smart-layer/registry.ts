/** The capability registry as the engine reads it. `registry.generated.json` is built by `apps/api/scripts/build-help-corpus.mjs` through the engine's own `toRegistryView`; a test fails when it is stale. */
import type { RegistryCap, RegistryView } from '@ebda/shared/smart-layer';
import generated from './registry.generated.json';

type StoredCap = Omit<RegistryCap, 'uiLabels'>;

function viewOf(stored: readonly StoredCap[]): RegistryView {
  // The engine's `toRegistryView` accepts the titles as the only UI labels; the same rule is applied here to the stored (label-free) form.
  const caps: RegistryCap[] = stored.map(c => ({
    ...c,
    uiLabels: { ar: [c.title.ar], en: [c.title.en] },
  }));
  const byId = new Map(caps.map(c => [c.id, c]));
  const byPath = new Map<string, RegistryCap>();
  for (const c of caps) for (const p of c.appPaths) if (!byPath.has(p)) byPath.set(p, c);
  return { caps: byId, byAppPath: p => byPath.get(p) };
}

let cached: RegistryView | undefined;
export const storeRegistry = (): RegistryView =>
  (cached ??= viewOf(generated as unknown as StoredCap[]));
