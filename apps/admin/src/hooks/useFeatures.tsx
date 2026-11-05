'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  ReactNode,
} from 'react';
import { useAuth } from '../lib/auth';
import { apiGet } from '../lib/api';

// ─── Types ────────────────────────────────────────────────────────────────────

interface FeaturesContextType {
  /** Returns true if the feature is enabled (defaults to true while loading) */
  isEnabled: (key: string) => boolean;
  isLoading: boolean;
  /**
   * The very first entitlements fetch failed (outage / offline) and there are no known flags. `isEnabled` then answers
   * true (the API still enforces), and `<PlanGate>` shows a retry state: a locked card means the server CONFIRMED the
   * feature is off, never "we could not ask".
   */
  loadFailed: boolean;
  /**
   * Re-fetch the flags now. Call it after ANY write that can change what the
   * store has access to (a feature toggle, a reset, a plan change) — the
   * provider is mounted once in `stores/[id]/layout.tsx` and survives every
   * soft navigation, so without this the sidebar, gates and Settings cards
   * stay on the pre-toggle flags until a hard reload (audit 2026-09-30 §9).
   * Resolves once the new flags are in context. Never flips `isLoading` back
   * to true, so consumers do not flash their skeletons on a refresh.
   */
  refresh: () => Promise<void>;
}

// ─── Context ──────────────────────────────────────────────────────────────────

const FeaturesContext = createContext<FeaturesContextType | undefined>(undefined);

// ─── Provider ─────────────────────────────────────────────────────────────────

interface AdminFeatureProviderProps {
  storeId: string;
  children: ReactNode;
}

/**
 * AdminFeatureProvider
 *
 * Fetches feature flags for the given store and exposes them via
 * FeaturesContext.  Two endpoints are used depending on the caller's role:
 *
 *   super_admin → GET /api/v1/admin/stores/:storeId/features
 *                 Response: { features: Record<string, boolean>, metadata: [...], registry: {...} }
 *
 *   store_admin → GET /api/v1/stores/:storeId/my-features
 *                 Response: { features: Record<string, boolean> }
 *
 * While loading, `isEnabled` returns `true` so the UI doesn't flash-hide
 * content before flags arrive.
 */
export function AdminFeatureProvider({ storeId, children }: AdminFeatureProviderProps) {
  const { user } = useAuth();
  const [features, setFeatures] = useState<Record<string, boolean>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const hasFlags = useRef(false);
  // Monotonic request id: a slow earlier response (e.g. the mount fetch)
  // must never overwrite a newer one (e.g. the refresh after a toggle).
  const requestSeq = useRef(0);

  const role = user?.role;
  // Keyed on the user's id (not the object) so a re-created-but-identical
  // user object does not refetch, while a different signed-in user does.
  const userId = user?.id;

  const fetchFeatures = useCallback(async () => {
    if (!storeId || !userId) return;
    const seq = ++requestSeq.current;
    const endpoint =
      role === 'super_admin'
        ? `/api/v1/admin/stores/${storeId}/features`
        : `/api/v1/stores/${storeId}/my-features`;

    const { data } = await apiGet<{ features: Record<string, boolean> }>(endpoint);

    if (seq !== requestSeq.current) return;
    // A failed refresh keeps the last known flags rather than blanking them.
    if (data?.features) {
      setFeatures(data.features);
      hasFlags.current = true;
      setLoadFailed(false);
    } else if (!hasFlags.current) {
      setLoadFailed(true);
    }
    setIsLoading(false);
  }, [storeId, userId, role]);

  useEffect(() => {
    if (!storeId || !userId) {
      // AuthProvider hasn't resolved yet OR storeId not in URL — STAY
      // in the loading state. Flipping to `false` here was the
      // 1-second flicker: the settings page rendered the (incorrectly
      // empty / unfiltered) card grid for a tick, then snapped back to
      // skeletons once user resolved and fetchFeatures kicked off,
      // then settled on the real cards once features loaded — three
      // layout swaps in a second, which read as a bug.
      return;
    }

    // The ref object (not its value) is captured for the cleanup below: the
    // cleanup must bump whatever the counter is AT CLEANUP TIME.
    const seqRef = requestSeq;
    void fetchFeatures();

    // Revalidate when the tab regains focus: a super-admin may have toggled
    // a feature for this store from another tab or device.
    function onFocus() {
      void fetchFeatures();
    }
    function onVisibilityChange() {
      if (document.visibilityState === 'visible') void fetchFeatures();
    }
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      // Invalidate any in-flight response for the old store/user.
      seqRef.current++;
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [storeId, userId, fetchFeatures]);

  function isEnabled(key: string): boolean {
    // While loading, default to true so items aren't hidden prematurely.
    if (isLoading) return true;
    // No flags could be loaded: do not claim anything is off (the server still enforces every gated route).
    if (loadFailed) return true;
    // If a key is absent from the map it means it was never explicitly enabled;
    // treat as disabled.
    return features[key] === true;
  }

  return (
    <FeaturesContext.Provider value={{ isEnabled, isLoading, loadFailed, refresh: fetchFeatures }}>
      {children}
    </FeaturesContext.Provider>
  );
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * useFeatures — consume the AdminFeatureProvider context.
 *
 * Returns a no-op context (isEnabled always true, isLoading false) when called
 * outside of an AdminFeatureProvider so that super-admin pages that don't wrap
 * the provider still render all items.
 */
export function useFeatures(): FeaturesContextType {
  const context = useContext(FeaturesContext);
  if (!context) {
    // Safe fallback: outside store context, show everything.
    return {
      isEnabled: () => true,
      isLoading: false,
      loadFailed: false,
      refresh: async () => {},
    };
  }
  return context;
}
