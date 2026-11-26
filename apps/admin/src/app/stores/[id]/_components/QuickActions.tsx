'use client';

import Link from 'next/link';
import { useToast } from '@ebda/ui';
import { cn } from '@ebda/ui';
import { useT } from '@/i18n/useT';
import { getStoreHref } from '../../../../lib/store-url';
import type { Store } from './types';

interface QuickActionsProps {
  store: Store;
  isSuperAdmin: boolean;
}

// Heroicons v2 outline, 24px grid, 1.5 stroke - the same set as the sidebar. None is directional.
const ICON = {
  product: 'M12 4.5v15m7.5-7.5h-15',
  order:
    'M2.25 3h1.386c.51 0 .955.343 1.087.835l.383 1.437M7.5 14.25a3 3 0 00-3 3h15.75m-12.75-3h11.218c1.121-2.3 2.1-4.684 2.924-7.138a60.114 60.114 0 00-16.536-1.84M7.5 14.25L5.106 5.272M6 20.25a.75.75 0 11-1.5 0 .75.75 0 011.5 0zm12.75 0a.75.75 0 11-1.5 0 .75.75 0 011.5 0z',
  coupon:
    'M9.568 3H5.25A2.25 2.25 0 003 5.25v4.318c0 .597.237 1.17.659 1.591l9.581 9.581c.699.699 1.78.872 2.607.33a18.095 18.095 0 005.223-5.223c.542-.827.369-1.908-.33-2.607L11.16 3.66A2.25 2.25 0 009.568 3z M6 6h.008v.008H6V6z',
  link: 'M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244',
  features:
    'M10.5 6h9.75M10.5 6a1.5 1.5 0 11-3 0m3 0a1.5 1.5 0 10-3 0M3.75 6H7.5m3 12h9.75m-9.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-3.75 0H7.5m9-6h3.75m-3.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-9.75 0h9.75',
};

const ROW =
  'flex min-h-14 w-full items-center gap-3 rounded-lg px-2 py-2 text-start transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary cursor-pointer';

function Glyph({ d }: { d: string }) {
  return (
    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary-ink">
      <svg
        aria-hidden="true"
        className="h-5 w-5"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d={d} />
      </svg>
    </span>
  );
}

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
    {
      href: `${base}/products/new`,
      title: t('addProduct'),
      body: t('addProductBody'),
      icon: ICON.product,
    },
    {
      href: `${base}/orders/new`,
      title: t('phoneOrder'),
      body: t('phoneOrderBody'),
      icon: ICON.order,
    },
    { href: `${base}/coupons`, title: t('newCoupon'), body: t('newCouponBody'), icon: ICON.coupon },
  ];

  return (
    <section className="rounded-md border bg-card p-5 shadow-sm" aria-label={t('title')}>
      <h2 className="mb-2 font-semibold text-foreground">{t('title')}</h2>
      <div className="flex flex-col">
        {jobs.map(j => (
          <Link key={j.href} href={j.href} className={ROW}>
            <Glyph d={j.icon} />
            <span className="min-w-0">
              <span className="block text-sm font-medium text-foreground">{j.title}</span>
              <span className="block text-xs text-muted-foreground">{j.body}</span>
            </span>
          </Link>
        ))}
        <button type="button" onClick={() => void copyLink()} data-ui="tile" className={ROW}>
          <Glyph d={ICON.link} />
          <span className="min-w-0">
            <span className="block text-sm font-medium text-foreground">{t('shareLink')}</span>
            <span className="block text-xs text-muted-foreground">{t('shareLinkBody')}</span>
          </span>
        </button>
        {isSuperAdmin && (
          <Link href={`${base}/features`} className={cn(ROW)}>
            <Glyph d={ICON.features} />
            <span className="min-w-0">
              <span className="block text-sm font-medium text-foreground">
                {t('manageFeatures')}
              </span>
              <span className="block text-xs text-muted-foreground">
                {t('manageFeaturesDescription')}
              </span>
            </span>
          </Link>
        )}
      </div>
    </section>
  );
}
