'use client';

import Link from 'next/link';
import { useToast } from '@ebda/ui';
import { useT } from '@/i18n/useT';
import { getStoreHref } from '../../../../lib/store-url';
import type { Store } from './types';

interface QuickActionsProps {
  store: Store;
  isSuperAdmin: boolean;
}

const CARD =
  'flex min-h-14 items-center gap-3 rounded-xl border bg-card p-4 text-start shadow-sm transition-all duration-200 hover:border-primary hover:shadow-md cursor-pointer';

/**
 * The jobs a merchant actually starts from the dashboard (UX:N-6, D-4): add a product, take a phone order, make a
 * coupon, share the store link. Suspend / activate is NOT here any more: it is a destructive super-admin action and
 * lives in the DangerZone.
 */
export function QuickActions({ store, isSuperAdmin }: QuickActionsProps) {
  const t = useT('stores.dashboard.quickActions');
  const { success, error } = useToast();
  const base = `/stores/${store.id}`;

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(getStoreHref(store));
      success(t('linkCopied'));
    } catch {
      error(t('linkCopyFailed'));
    }
  };

  const jobs = [
    { href: `${base}/products/new`, title: t('addProduct'), body: t('addProductBody') },
    { href: `${base}/orders/new`, title: t('phoneOrder'), body: t('phoneOrderBody') },
    { href: `${base}/coupons`, title: t('newCoupon'), body: t('newCouponBody') },
  ];

  return (
    <div className="mt-8">
      <h2 className="mb-4 font-semibold text-foreground">{t('title')}</h2>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {jobs.map(j => (
          <Link key={j.href} href={j.href} className={CARD}>
            <div>
              <p className="font-medium text-foreground">{j.title}</p>
              <p className="text-xs text-muted-foreground">{j.body}</p>
            </div>
          </Link>
        ))}
        <button type="button" onClick={() => void copyLink()} data-ui="tile" className={CARD}>
          <div>
            <p className="font-medium text-foreground">{t('shareLink')}</p>
            <p className="text-xs text-muted-foreground">{t('shareLinkBody')}</p>
          </div>
        </button>
        {isSuperAdmin && (
          <Link href={`${base}/features`} className={CARD}>
            <div>
              <p className="font-medium text-foreground">{t('manageFeatures')}</p>
              <p className="text-xs text-muted-foreground">{t('manageFeaturesDescription')}</p>
            </div>
          </Link>
        )}
      </div>
    </div>
  );
}
