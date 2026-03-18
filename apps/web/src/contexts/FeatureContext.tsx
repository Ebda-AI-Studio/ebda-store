'use client';

import { createContext, useContext, useMemo, useCallback, type ReactNode } from 'react';
import { useStore } from './StoreContext';

interface FeatureContextValue {
  features: Set<string>;
  isEnabled: (key: string) => boolean;
}

const FeatureContext = createContext<FeatureContextValue | null>(null);

interface FeatureProviderProps {
  children: ReactNode;
}

export function FeatureProvider({ children }: FeatureProviderProps) {
  const { store } = useStore();

  const features = useMemo(
    () => new Set<string>(store.enabledFeatures ?? []),
    [store.enabledFeatures]
  );

  const isEnabled = useCallback((key: string): boolean => features.has(key), [features]);

  return (
    <FeatureContext.Provider value={{ features, isEnabled }}>{children}</FeatureContext.Provider>
  );
}

/**
 * Hook to access feature flags in client components.
 * Must be used within a FeatureProvider.
 */
export function useFeatures(): FeatureContextValue {
  const context = useContext(FeatureContext);

  if (!context) {
    throw new Error('useFeatures must be used within a FeatureProvider');
  }

  return context;
}
