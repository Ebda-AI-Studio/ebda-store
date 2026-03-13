'use client';

import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { useAuth } from '@/lib/auth';
import { apiGet } from '@/lib/api';

interface Store {
  id: string;
  name: string;
}

interface StoreContextType {
  stores: Store[];
  selectedStoreId: string;
  setSelectedStoreId: (id: string) => void;
  selectedStore: Store | undefined;
  isLoading: boolean;
}

const StoreContext = createContext<StoreContextType | null>(null);

const STORAGE_KEY = 'selectedStoreId';

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const { isAuthenticated } = useAuth();
  const [stores, setStores] = useState<Store[]>([]);
  const [selectedStoreId, setSelectedStoreIdState] = useState<string>('all');
  const [isLoading, setIsLoading] = useState(true);

  const setSelectedStoreId = useCallback((id: string) => {
    setSelectedStoreIdState(id);
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      // localStorage may be unavailable
    }
  }, []);

  useEffect(() => {
    if (!isAuthenticated) return;

    async function fetchStores() {
      try {
        const { data } = await apiGet<{ stores?: Store[] } | Store[]>('/api/v1/admin/stores');
        if (data) {
          const raw = (data as { stores?: Store[] }).stores || data;
          const storeList: Store[] = Array.isArray(raw) ? raw : [];
          setStores(storeList);

          // Restore from localStorage or pick default
          let persisted: string | null = null;
          try {
            persisted = localStorage.getItem(STORAGE_KEY);
          } catch {
            // ignore
          }

          if (persisted && (persisted === 'all' || storeList.some(s => s.id === persisted))) {
            setSelectedStoreIdState(persisted);
          } else if (storeList.length === 1) {
            setSelectedStoreIdState(storeList[0].id);
          } else {
            setSelectedStoreIdState('all');
          }
        }
      } catch {
        // Store fetch failed — will show empty
      } finally {
        setIsLoading(false);
      }
    }

    fetchStores();
  }, [isAuthenticated]);

  const selectedStore = stores.find(s => s.id === selectedStoreId);

  return (
    <StoreContext.Provider
      value={{
        stores,
        selectedStoreId,
        setSelectedStoreId,
        selectedStore,
        isLoading,
      }}
    >
      {children}
    </StoreContext.Provider>
  );
}

export function useStore() {
  const context = useContext(StoreContext);
  if (!context) {
    throw new Error('useStore must be used within a StoreProvider');
  }
  return context;
}
