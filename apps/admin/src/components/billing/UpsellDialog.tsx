'use client';

import { Button, buttonVariants } from '@/components/ui/Button';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useLocale } from 'next-intl';
import { useT } from '../../i18n/useT';
import type { UpsellEventDetail } from '../../lib/api';

/**
 * 402 codes the calling screen already explains inline (the go-live step shows
 * its own message and a link to billing) — a second pop-up would just repeat it.
 */
const HANDLED_INLINE = new Set(['PAYMENT_METHOD_REQUIRED', 'TRIAL_EXPIRED', 'NO_SUBSCRIPTION']);

/**
 * Where "Upgrade" goes: this store's billing page plan picker (`#plans`), read from the
 * current /stores/<id>/... path. The picker works for card and InstaPay merchants alike.
 */
export function billingHref(pathname: string, planCode: string | null): string {
  const m = /^\/stores\/([^/]+)/.exec(pathname);
  if (!m) return '/stores';
  return `/stores/${m[1]}/billing${planCode ? `?plan=${encodeURIComponent(planCode)}` : ''}#plans`;
}

/**
 * Listens for the `ebda:upsell` event the API client fires on any 402 and
 * shows the (already localized) message with a way to upgrade. Mounted once in
 * the authenticated shell.
 */
export function UpsellDialog() {
  const t = useT('upsell');
  const locale = useLocale() === 'ar' ? 'ar' : 'en';
  const [event, setEvent] = useState<UpsellEventDetail | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onUpsell = (e: Event) => {
      const detail = (e as CustomEvent<UpsellEventDetail>).detail;
      if (!detail || HANDLED_INLINE.has(detail.code)) return;
      setEvent(detail);
    };
    // A page that already shows its own upgrade card (PlanLockedCard) closes the modal: one upsell, not two.
    const onCardShown = () => setEvent(null);
    window.addEventListener('ebda:upsell', onUpsell);
    window.addEventListener('ebda:upsell-card-shown', onCardShown);
    return () => {
      window.removeEventListener('ebda:upsell', onUpsell);
      window.removeEventListener('ebda:upsell-card-shown', onCardShown);
    };
  }, []);

  const close = useCallback(() => setEvent(null), []);

  useEffect(() => {
    if (!event) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [event, close]);

  if (!event) return null;

  const upgradeTo = event.upgradeTo;
  const target =
    upgradeTo && typeof upgradeTo === 'object'
      ? { code: upgradeTo.code, name: locale === 'ar' ? upgradeTo.nameAr : upgradeTo.nameEn }
      : typeof upgradeTo === 'string'
        ? { code: upgradeTo, name: null }
        : null;
  const planName = target?.name ?? null;
  const href = billingHref(window.location.pathname, target?.code ?? null);

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="upsell-title"
      aria-describedby="upsell-body"
      className="fixed inset-x-4 bottom-4 z-[100] mx-auto max-w-md rounded-xl border bg-card p-4 shadow-lg sm:bottom-6"
    >
      <h2 id="upsell-title" className="text-base font-semibold text-foreground">
        {t('title')}
      </h2>
      <p id="upsell-body" className="mt-1 text-sm text-muted-foreground">
        {event.message}
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Link href={href} onClick={close} className={buttonVariants()}>
          {planName ? t('upgradeTo', { plan: planName }) : t('seePlans')}
        </Link>
        <Button variant="outline" ref={closeRef} type="button" onClick={close}>
          {t('dismiss')}
        </Button>
      </div>
    </div>
  );
}
