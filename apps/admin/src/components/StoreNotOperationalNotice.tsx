'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { BRAND } from '@ebda/shared';
import { Button, buttonVariants } from '@/components/ui/Button';
import { useT } from '../i18n/useT';
import { STORE_NOT_OPERATIONAL_EVENT, apiGetQuiet } from '../lib/api';

/** The outside-a-store fallback (no store in the URL): the appeal goes to the Ebda support mailbox. */
function appealHref(): string {
  return `mailto:${BRAND.supportEmail}?subject=${encodeURIComponent('Store suspension appeal')}`;
}

/** The store the merchant is working in, from the admin URL (`/stores/<id>/...`); null on pages outside a store. */
function storeIdFromPath(): string | null {
  if (typeof window === 'undefined') return null;
  return /^\/stores\/([^/?#]+)/.exec(window.location.pathname)?.[1] ?? null;
}

/** Where the dialog sends the merchant: the suspension banner's appeal form, or the invoice for a billing suspension. */
type Target = { kind: 'policy' | 'billing'; storeId: string } | null;

/**
 * Answers the API client's 423 STORE_NOT_OPERATIONAL (Ruling SUSPEND-OUT-1): instead of a generic error, tells the
 * merchant the store is suspended (what that stops) and links to the way out: the appeal form (SuspensionNotice, shown on every
 * store page) for a policy suspension, the billing page for a billing suspension (same split as the assistant's
 * suspension-appeal tool, which refuses a billing case and says to pay the invoice). Mounted once in the authenticated shell.
 */
export function StoreNotOperationalNotice() {
  const t = useT('common');
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<Target>(null);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    const on = () => {
      setTarget(null);
      setOpen(true);
      const storeId = storeIdFromPath();
      if (!storeId) return;
      void apiGetQuiet<{ kind: 'policy' | 'billing' }>(`/api/v1/stores/${storeId}/suspension`).then(
        res => {
          if (res.data) setTarget({ kind: res.data.kind, storeId });
        }
      );
    };
    window.addEventListener(STORE_NOT_OPERATIONAL_EVENT, on);
    return () => window.removeEventListener(STORE_NOT_OPERATIONAL_EVENT, on);
  }, []);

  if (!open) return null;
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="store-not-operational-title"
      aria-describedby="store-not-operational-body"
      className="fixed inset-x-4 bottom-4 z-[100] mx-auto max-w-md rounded-xl border bg-card p-4 shadow-lg sm:bottom-6"
    >
      <h2 id="store-not-operational-title" className="text-base font-semibold text-foreground">
        {t('storeNotOperationalTitle')}
      </h2>
      <p id="store-not-operational-body" className="mt-1 text-sm text-muted-foreground">
        {target?.kind === 'billing' ? t('storeNotOperationalBilling') : t('storeNotOperational')}
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        {target?.kind === 'billing' ? (
          <Link
            href={`/stores/${target.storeId}/billing`}
            onClick={close}
            className={buttonVariants()}
          >
            {t('storeNotOperationalPay')}
          </Link>
        ) : target ? (
          <Link
            href={`/stores/${target.storeId}#suspension-notice`}
            onClick={close}
            className={buttonVariants()}
          >
            {t('storeNotOperationalAppealForm')}
          </Link>
        ) : (
          <a href={appealHref()} onClick={close} className={buttonVariants()}>
            {t('storeNotOperationalAppeal')}
          </a>
        )}
        <Button variant="outline" type="button" onClick={close}>
          {t('close')}
        </Button>
      </div>
    </div>
  );
}
