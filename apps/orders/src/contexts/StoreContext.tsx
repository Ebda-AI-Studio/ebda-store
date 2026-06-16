'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { apiGet } from '@/lib/api';

export interface Store {
  id: string;
  name: string;
}

interface StoreContextType {
  stores: Store[];
  selectedStoreId: string | null;
  setSelectedStoreId: (id: string) => void;
  selectedStore: Store | undefined;
  isLoading: boolean;
}

const StoreContext = createContext<StoreContextType | null>(null);

const STORAGE_KEY = 'force-orders-selectedStoreId';

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const { isAuthenticated } = useAuth();
  const [stores, setStores] = useState<Store[]>([]);
  const [selectedStoreId, setSelectedStoreIdState] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const setSelectedStoreId = useCallback((id: string) => {
    setSelectedStoreIdState(id);
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;

    async function fetchStores() {
      try {
        const { data } = await apiGet<{ stores?: Store[] } | Store[]>('/api/v1/admin/stores');
        if (cancelled) return;
        const raw = (data as { stores?: Store[] })?.stores ?? data;
        const storeList: Store[] = Array.isArray(raw) ? raw : [];
        setStores(storeList);

        let persisted: string | null = null;
        try {
          persisted = localStorage.getItem(STORAGE_KEY);
        } catch {
          // ignore
        }

        if (persisted && storeList.some(s => s.id === persisted)) {
          setSelectedStoreIdState(persisted);
        } else if (storeList.length > 0) {
          // Default to the first store (single-store merchants auto-select).
          setSelectedStoreIdState(storeList[0].id);
        }
      } catch {
        // store fetch failed — empty state shown
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    fetchStores();
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated]);

  const selectedStore = stores.find(s => s.id === selectedStoreId);

  return (
    <StoreContext.Provider
      value={{ stores, selectedStoreId, setSelectedStoreId, selectedStore, isLoading }}
    >
      {children}
    </StoreContext.Provider>
  );
}

export function useStore() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useStore must be used within a StoreProvider');
  return ctx;
}
