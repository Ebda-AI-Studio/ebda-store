'use client';

import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { useAuth } from '../lib/auth';
import { apiGet } from '../lib/api';

// ─── Types ────────────────────────────────────────────────────────────────────

interface FeaturesContextType {
  /** Returns true if the feature is enabled (defaults to true while loading) */
  isEnabled: (key: string) => boolean;
  isLoading: boolean;
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

  useEffect(() => {
    if (!storeId || !user) {
      setIsLoading(false);
      return;
    }

    let cancelled = false;

    async function fetchFeatures() {
      setIsLoading(true);

      const endpoint =
        user!.role === 'super_admin'
          ? `/api/v1/admin/stores/${storeId}/features`
          : `/api/v1/stores/${storeId}/my-features`;

      const { data } = await apiGet<{ features: Record<string, boolean> }>(endpoint);

      if (!cancelled) {
        if (data?.features) {
          setFeatures(data.features);
        }
        setIsLoading(false);
      }
    }

    fetchFeatures();

    return () => {
      cancelled = true;
    };
  }, [storeId, user]);

  function isEnabled(key: string): boolean {
    // While loading, default to true so items aren't hidden prematurely.
    if (isLoading) return true;
    // If a key is absent from the map it means it was never explicitly enabled;
    // treat as disabled.
    return features[key] === true;
  }

  return (
    <FeaturesContext.Provider value={{ isEnabled, isLoading }}>{children}</FeaturesContext.Provider>
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
    };
  }
  return context;
}
