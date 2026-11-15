'use client';

import { useCallback, useEffect, useState } from 'react';
import { BRAND } from '@ebda/shared';
import { Button, buttonVariants } from '@/components/ui/Button';
import { useT } from '../i18n/useT';
import { STORE_NOT_OPERATIONAL_EVENT } from '../lib/api';

/** mailto: the appeal goes to the Ebda support mailbox (there is no appeal page; support handles it). */
export function appealHref(): string {
  return `mailto:${BRAND.supportEmail}?subject=${encodeURIComponent('Store suspension appeal')}`;
}

/**
 * Answers the API client's 423 STORE_NOT_OPERATIONAL (Ruling SUSPEND-OUT-1): instead of a generic error, tells the
 * merchant the store is suspended (what that stops) and links to the appeal. Mounted once in the authenticated shell.
 */
export function StoreNotOperationalNotice() {
  const t = useT('common');
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    const on = () => setOpen(true);
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
        {t('storeNotOperational')}
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        <a href={appealHref()} onClick={close} className={buttonVariants()}>
          {t('storeNotOperationalAppeal')}
        </a>
        <Button variant="outline" type="button" onClick={close}>
          {t('close')}
        </Button>
      </div>
    </div>
  );
}
