'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiPatch, apiPut } from '../../../../lib/api';
import type { Store, StoreEditForm, StoreFormErrors } from '../_components/types';

export type StoreLoadError = 'not_found' | 'network' | null;

export interface DashboardData {
  store: Store | null;
  isLoading: boolean;
  storeError: StoreLoadError;
  isEditing: boolean;
  isSaving: boolean;
  isChangingStatus: boolean;
  editForm: StoreEditForm;
  formErrors: StoreFormErrors;
  setIsLoading: (loading: boolean) => void;
  setIsEditing: (editing: boolean) => void;
  setEditForm: React.Dispatch<React.SetStateAction<StoreEditForm>>;
  setFormErrors: React.Dispatch<React.SetStateAction<StoreFormErrors>>;
  fetchStore: () => Promise<void>;
  handleSave: (translateError: (key: string) => string) => Promise<void>;
  handleStatusChange: (newStatus: string) => Promise<void>;
  resetEditForm: () => void;
}

// Keeps the fetch + form state for the store dashboard in one place so
// page.tsx stays focused on layout.
export function useDashboardData(storeId: string): DashboardData {
  const [store, setStore] = useState<Store | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [storeError, setStoreError] = useState<StoreLoadError>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isChangingStatus, setIsChangingStatus] = useState(false);
  const [editForm, setEditForm] = useState<StoreEditForm>({
    name: '',
    slug: '',
    plan: '',
    status: '',
  });
  const [formErrors, setFormErrors] = useState<StoreFormErrors>({});

  const fetchStore = useCallback(async () => {
    if (!storeId) return;
    try {
      setStoreError(null);
      const { data, error } = await apiGet<{ store: Store }>(`/api/v1/stores/${storeId}`);
      if (error) {
        setStoreError(error.status === 404 ? 'not_found' : 'network');
        return;
      }
      if (data?.store) {
        setStore(data.store);
        setEditForm({
          name: data.store.name,
          slug: data.store.slug,
          plan: data.store.plan,
          status: data.store.status,
        });
      }
    } catch (error) {
      console.error('Failed to fetch store:', error);
      setStoreError('network');
    } finally {
      setIsLoading(false);
    }
  }, [storeId]);

  useEffect(() => {
    fetchStore();
  }, [fetchStore]);

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

  const handleStatusChange = useCallback(
    async (newStatus: string) => {
      setIsChangingStatus(true);
      try {
        await apiPatch(`/api/v1/stores/${storeId}/status`, { status: newStatus });
        await fetchStore();
      } finally {
        setIsChangingStatus(false);
      }
    },
    [storeId, fetchStore]
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
    isChangingStatus,
    editForm,
    formErrors,
    setIsLoading,
    setIsEditing,
    setEditForm,
    setFormErrors,
    fetchStore,
    handleSave,
    handleStatusChange,
    resetEditForm,
  };
}
