'use client';

import { useCallback, useState, type ReactNode } from 'react';
import { useToast } from '@ebda/ui';
import { apiDelete } from '@/lib/api';
import { deleteStoreErrorKey } from '@/lib/delete-store-error';
import { useConfirm } from '@/hooks/useConfirm';
import { useT } from '@/i18n/useT';
import { DeleteStoreDialog, type DeletableStore } from './DeleteStoreDialog';

/**
 * Super-admin "delete store": typed-slug dialog, then `useConfirm()` (danger), then DELETE /api/v1/stores/:id.
 * The caller only mounts `dialog` and reacts to `onDeleted`; callers must render this for super_admin only
 * (the API enforces it too).
 */
export function useDeleteStore(onDeleted: (store: DeletableStore) => void): {
  requestDelete: (store: DeletableStore) => void;
  dialog: ReactNode;
} {
  const t = useT('stores.deleteStore');
  const askConfirm = useConfirm();
  const { success: toastSuccess } = useToast();
  const [target, setTarget] = useState<DeletableStore | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mfa, setMfa] = useState(false);

  const close = useCallback(() => {
    setTarget(null);
    setError(null);
    setMfa(false);
  }, []);

  const requestDelete = useCallback((store: DeletableStore) => {
    setError(null);
    setMfa(false);
    setTarget(store);
  }, []);

  const submit = useCallback(async () => {
    if (!target) return;
    const store = target;
    const ok = await askConfirm({
      object: t('confirmObject', { name: store.name }),
      consequence: t('consequence', { name: store.name }),
      confirmLabel: t('confirmLabel'),
      tone: 'danger',
    });
    if (!ok) return;
    setIsDeleting(true);
    setError(null);
    setMfa(false);
    try {
      const { error: apiError } = await apiDelete(`/api/v1/stores/${store.id}`);
      if (apiError) {
        const key = deleteStoreErrorKey(apiError);
        setError(key ? t(key) : apiError.message);
        setMfa(key === 'errMfaRequired');
        return;
      }
      toastSuccess(t('deletedToast'), t('deletedToastBody', { name: store.name }));
      close();
      onDeleted(store);
    } catch {
      setError(t('errNetwork'));
    } finally {
      setIsDeleting(false);
    }
  }, [target, askConfirm, t, toastSuccess, close, onDeleted]);

  const dialog = (
    <DeleteStoreDialog
      store={target}
      isDeleting={isDeleting}
      error={error}
      showSecurityLink={mfa}
      onClose={close}
      onSubmit={submit}
    />
  );

  return { requestDelete, dialog };
}
