'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Input, Modal } from '@ebda/ui';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/useT';

export interface DeletableStore {
  id: string;
  name: string;
  slug: string;
}

interface DeleteStoreDialogProps {
  store: DeletableStore | null;
  isDeleting: boolean;
  /** Localized failure text from the last attempt. */
  error: string | null;
  /** True when the failure is MFA_SETUP_REQUIRED: shows the account-security link. */
  showSecurityLink: boolean;
  onClose: () => void;
  /** Called once the slug matches exactly and the person presses the delete button. */
  onSubmit: () => void;
}

/** True only when the typed text equals the slug exactly (no trimming, no case folding). */
export function slugMatches(typed: string, slug: string): boolean {
  return typed.length > 0 && typed === slug;
}

/**
 * Typed-slug step of the super-admin "delete store" flow. The final `useConfirm()` step runs in
 * `useDeleteStore` after this one.
 */
export function DeleteStoreDialog({
  store,
  isDeleting,
  error,
  showSecurityLink,
  onClose,
  onSubmit,
}: DeleteStoreDialogProps) {
  const t = useT('stores.deleteStore');
  const [typed, setTyped] = useState('');

  useEffect(() => {
    setTyped('');
  }, [store?.id]);

  const open = store !== null;
  const ok = store ? slugMatches(typed, store.slug) : false;

  return (
    <Modal isOpen={open} onClose={isDeleting ? () => {} : onClose} title={t('title')}>
      {store && (
        <>
          <div className="space-y-4">
            <p className="text-sm text-foreground">{t('consequence', { name: store.name })}</p>
            <div>
              <label
                htmlFor="delete-store-slug-input"
                className="mb-2 block text-sm font-medium text-foreground"
              >
                {t('typeSlugLabel', { slug: store.slug })}
              </label>
              <Input
                id="delete-store-slug-input"
                value={typed}
                onChange={e => setTyped(e.target.value)}
                placeholder={t('typeSlugPlaceholder')}
                disabled={isDeleting}
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                dir="ltr"
              />
            </div>
            {error && (
              <div
                role="alert"
                className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive-ink"
              >
                <p>{error}</p>
                {showSecurityLink && (
                  <Link
                    href="/account/security"
                    className="mt-2 inline-block font-medium underline"
                  >
                    {t('securityLink')}
                  </Link>
                )}
              </div>
            )}
          </div>
          <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <Button variant="outline" onClick={onClose} disabled={isDeleting}>
              {t('cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={onSubmit}
              disabled={!ok || isDeleting}
              aria-disabled={!ok || isDeleting}
            >
              {isDeleting ? t('deleting') : t('submit')}
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}
