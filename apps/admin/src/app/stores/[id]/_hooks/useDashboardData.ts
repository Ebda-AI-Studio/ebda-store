'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiPut } from '../../../../lib/api';
import { useCurrentStore } from '../../../../hooks/useCurrentStore';
import type { Store, StoreEditForm, StoreFormErrors } from '../_components/types';

export type StoreLoadError = 'not_found' | 'network' | null;

export interface DashboardData {
  store: Store | null;
  isLoading: boolean;
  storeError: StoreLoadError;
  isEditing: boolean;
  isSaving: boolean;
  editForm: StoreEditForm;
  formErrors: StoreFormErrors;
  setIsLoading: (loading: boolean) => void;
  setIsEditing: (editing: boolean) => void;
  setEditForm: React.Dispatch<React.SetStateAction<StoreEditForm>>;
  setFormErrors: React.Dispatch<React.SetStateAction<StoreFormErrors>>;
  fetchStore: () => Promise<void>;
  handleSave: (translateError: (key: string) => string) => Promise<void>;
  resetEditForm: () => void;
}

// Keeps the fetch + form state for the store dashboard in one place so
// page.tsx stays focused on layout.
export function useDashboardData(storeId: string): DashboardData {
  const {
    store: fetchedStore,
    isLoading: isFetchingStore,
    error: fetchError,
    refetch,
  } = useCurrentStore(storeId);
  // Local mirror so successful PUTs can update the dashboard immediately
  // without an extra round-trip through the cache.
  const [store, setStore] = useState<Store | null>(null);
  const [storeError, setStoreError] = useState<StoreLoadError>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [editForm, setEditForm] = useState<StoreEditForm>({
    name: '',
    slug: '',
    plan: '',
    status: '',
  });
  const [formErrors, setFormErrors] = useState<StoreFormErrors>({});
  // Mirrors the hook's loading flag but stays true until we've seeded local
  // state, so the page never renders against an empty form.
  const [isLoading, setIsLoading] = useState(true);

  // Narrow the shared store shape to the dashboard's Store contract.
  useEffect(() => {
    if (fetchedStore) {
      setStore(fetchedStore as unknown as Store);
      setEditForm({
        name: fetchedStore.name,
        slug: fetchedStore.slug,
        plan: fetchedStore.plan ?? '',
        status: fetchedStore.status ?? '',
      });
      setStoreError(null);
      setIsLoading(false);
    } else if (!isFetchingStore) {
      setIsLoading(false);
    }
  }, [fetchedStore, isFetchingStore]);

  // Translate the hook's Error into the 'not_found' | 'network' discriminant
  // so the page can render the existing not-found UI.
  useEffect(() => {
    if (fetchError) {
      setStoreError(fetchError.message === 'Store not found' ? 'not_found' : 'network');
    }
  }, [fetchError]);

  const fetchStore = useCallback(async () => {
    await refetch();
  }, [refetch]);

  function validateForm(translateError: (key: string) => string): boolean {
    const errors: StoreFormErrors = {};

    if (!editForm.name.trim()) {
      errors.name = translateError('nameRequired');
    } else if (editForm.name.trim().length < 2) {
      errors.name = translateError('nameTooShort');
    } else if (editForm.name.trim().length > 100) {
      errors.name = translateError('nameTooLong');
    }

    if (!editForm.slug.trim()) {
      errors.slug = translateError('slugRequired');
    } else if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(editForm.slug)) {
      errors.slug = translateError('slugInvalid');
    } else if (editForm.slug.length < 3) {
      errors.slug = translateError('slugTooShort');
    } else if (editForm.slug.length > 50) {
      errors.slug = translateError('slugTooLong');
    }

    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  }

  const handleSave = useCallback(
    async (translateError: (key: string) => string) => {
      if (!validateForm(translateError)) return;

      setIsSaving(true);
      try {
        const { data, error: apiError } = await apiPut<{ store: Store }>(
          `/api/v1/stores/${storeId}`,
          {
            name: editForm.name.trim(),
            slug: editForm.slug.trim().toLowerCase(),
            plan: editForm.plan,
            status: editForm.status,
          }
        );
        if (data?.store) {
          setStore(data.store);
          setIsEditing(false);
          setFormErrors({});
        } else if (apiError) {
          if (apiError.message?.toLowerCase().includes('slug')) {
            setFormErrors({ slug: translateError('slugTaken') });
          }
        }
      } catch (error) {
        console.error('Failed to update store:', error);
      } finally {
        setIsSaving(false);
      }
    },
    // validateForm closes over editForm/setFormErrors; those are stable setState / state referenced here
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [storeId, editForm]
  );

  const resetEditForm = useCallback(() => {
    setFormErrors({});
    if (store) {
      setEditForm({
        name: store.name,
        slug: store.slug,
        plan: store.plan,
        status: store.status,
      });
    }
  }, [store]);

  return {
    store,
    isLoading,
    storeError,
    isEditing,
    isSaving,
    editForm,
    formErrors,
    setIsLoading,
    setIsEditing,
    setEditForm,
    setFormErrors,
    fetchStore,
    handleSave,
    resetEditForm,
  };
}
