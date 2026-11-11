'use client';

import { useEffect, useState } from 'react';
import { useT } from '@/i18n/useT';
import { Button } from '@/components/ui/Button';

export const nudgeStorageKey = (storeId: string) => `ebda.cart-email-nudge.${storeId}`;

/** Where "Review settings" scrolls to: the email block in RecoveryCampaignForm. */
export const CART_EMAIL_SETTINGS_ID = 'cart-email-settings';

interface Props {
  storeId: string;
  emailEnabled: boolean;
}

/**
 * One dismissible nudge while the recovery email is OFF (it ships off: the mail goes out in the
 * merchant's name, so they should see sender, copy and delay once; Ruling CART-EMAIL-2). A
 * per-viewer convenience in localStorage, never state anything depends on: with storage blocked it
 * still renders and dismisses for the session.
 */
export function CartEmailNudge({ storeId, emailEnabled }: Props) {
  const t = useT('abandonedCarts.emailNudge');
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    try {
      if (localStorage.getItem(nudgeStorageKey(storeId)) === '1') setDismissed(true);
    } catch {
      // storage unavailable: show the nudge
    }
  }, [storeId]);

  if (emailEnabled || dismissed) return null;

  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(nudgeStorageKey(storeId), '1');
    } catch {
      // not remembered across visits; fine
    }
  };

  return (
    <div
      role="region"
      aria-label={t('title')}
      className="rounded-xl border border-primary/30 bg-primary/5 p-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
    >
      <div>
        <p className="font-medium text-foreground">{t('title')}</p>
        <p className="text-sm text-muted-foreground mt-0.5">{t('body')}</p>
      </div>
      <div className="flex gap-2 shrink-0">
        <Button
          variant="default"
          size="sm"
          type="button"
          onClick={() =>
            document.getElementById(CART_EMAIL_SETTINGS_ID)?.scrollIntoView({ behavior: 'smooth' })
          }
        >
          {t('review')}
        </Button>
        <Button variant="outline" size="sm" type="button" onClick={dismiss}>
          {t('dismiss')}
        </Button>
      </div>
    </div>
  );
}
