'use client';

import { useId, useState } from 'react';
import Link from 'next/link';
import { Modal, useToast } from '@ebda/ui';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/useT';
import { apiPatch } from '@/lib/api';

/** The API's cap on a suspension reason (`storeStatusBody`, store.routes.ts). */
const SUSPEND_REASON_MAX = 500;

interface StoreStatusControlProps {
  storeId: string;
  storeName: string;
  /** `active`, `inactive` or `suspended`. */
  status: string;
  /** Called after the API confirmed the change, so the page re-reads the store. */
  onChanged: () => void | Promise<void>;
}

/**
 * Suspend / Reinstate a store: the ONE super-admin writer of a platform suspension (QA-81). The dashboard, Settings and
 * Features danger zones all render this, so none of them can suspend without a reason or without a confirmation.
 *
 * Suspend: a required reason (what the merchant reads in the banner, and what the appeal answers), confirmed in-page.
 * Reinstate: confirmed in-page; the API also closes the store's open appeal. Both go to
 * `PATCH /api/v1/stores/:id/status` (super_admin + MFA on the server; hiding this for other roles is the caller's job).
 */
export function StoreStatusControl({
  storeId,
  storeName,
  status,
  onChanged,
}: StoreStatusControlProps) {
  const t = useT('storeStatus');
  const { success: toastSuccess } = useToast();
  const reasonId = useId();
  const [open, setOpen] = useState<'suspend' | 'reinstate' | null>(null);
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const suspended = status === 'suspended';
  const trimmed = reason.trim();
  const reasonInvalid = open === 'suspend' && trimmed.length === 0;

  const close = () => {
    if (busy) return;
    setOpen(null);
    setReason('');
    setTouched(false);
    setError(null);
  };

  const submit = async () => {
    if (!open) return;
    if (open === 'suspend' && trimmed.length === 0) {
      setTouched(true);
      return;
    }
    setBusy(true);
    setError(null);
    const { error: apiErr } = await apiPatch(`/api/v1/stores/${storeId}/status`, {
      status: open === 'suspend' ? 'suspended' : 'active',
      ...(open === 'suspend' ? { reason: trimmed } : {}),
    });
    setBusy(false);
    if (apiErr) {
      setError(t('failed'));
      return;
    }
    toastSuccess(
      open === 'suspend' ? t('suspendedToast') : t('reinstatedToast'),
      t(open === 'suspend' ? 'suspendedToastBody' : 'reinstatedToastBody', { name: storeName })
    );
    setOpen(null);
    setReason('');
    setTouched(false);
    await onChanged();
  };

  return (
    <>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex-1">
          <p className="text-sm font-medium text-foreground">
            {suspended ? t('reinstateTitle') : t('suspendTitle')}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {suspended ? t('reinstateDescription') : t('suspendDescription')}
          </p>
          {suspended && (
            <p className="mt-1 text-sm">
              <Link href="/trust-requests" className="text-primary-ink underline">
                {t('appealsLink')}
              </Link>
            </p>
          )}
        </div>
        <div className="shrink-0">
          <Button
            variant={suspended ? 'default' : 'destructive'}
            onClick={() => setOpen(suspended ? 'reinstate' : 'suspend')}
          >
            {suspended ? t('reinstateTitle') : t('suspendTitle')}
          </Button>
        </div>
      </div>

      <Modal
        isOpen={open !== null}
        onClose={close}
        title={open === 'reinstate' ? t('reinstateTitle') : t('suspendTitle')}
        size="sm"
      >
        {open === 'suspend' ? (
          <>
            <p className="text-sm text-muted-foreground">{t('suspendBody', { name: storeName })}</p>
            <label htmlFor={reasonId} className="mt-4 block text-sm font-medium text-foreground">
              {t('reasonLabel')}
            </label>
            <textarea
              id={reasonId}
              value={reason}
              onChange={e => setReason(e.target.value)}
              onBlur={() => setTouched(true)}
              maxLength={SUSPEND_REASON_MAX}
              rows={4}
              required
              aria-required="true"
              aria-invalid={touched && reasonInvalid}
              aria-describedby={`${reasonId}-hint`}
              disabled={busy}
              className="mt-1 w-full rounded-md border border-border bg-background p-2 text-sm"
            />
            <p
              id={`${reasonId}-hint`}
              className={`mt-1 text-xs ${touched && reasonInvalid ? 'text-destructive-ink' : 'text-muted-foreground'}`}
            >
              {touched && reasonInvalid ? t('reasonRequired') : t('reasonHint')}
            </p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">{t('reinstateBody', { name: storeName })}</p>
        )}
        {error && (
          <p role="alert" className="mt-3 text-sm text-destructive-ink">
            {error}
          </p>
        )}
        <div className="mt-6 flex justify-end gap-3">
          <Button variant="outline" onClick={close} disabled={busy}>
            {t('cancel')}
          </Button>
          <Button
            variant={open === 'reinstate' ? 'default' : 'destructive'}
            onClick={submit}
            disabled={busy || (open === 'suspend' && touched && reasonInvalid)}
            isLoading={busy}
          >
            {open === 'reinstate' ? t('reinstateConfirm') : t('suspendConfirm')}
          </Button>
        </div>
      </Modal>
    </>
  );
}
