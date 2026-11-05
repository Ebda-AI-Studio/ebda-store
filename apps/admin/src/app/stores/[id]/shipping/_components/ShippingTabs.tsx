'use client';

import Link from 'next/link';
import { useParams, usePathname } from 'next/navigation';
import { cn } from '@ebda/ui';
import { useT } from '@/i18n/useT';
import { useFeatures } from '../../../../../hooks/useFeatures';

/**
 * One "الشحن والتوصيل" page as four tabs (decision D2). Each tab keeps its own URL (existing links, the admin search
 * deep links and bookmarks stay valid), and every one of the four pages renders this strip at the top, so the merchant
 * moves between prices, carriers, delivery times and cash-on-delivery collection without going back to Settings.
 */
export function ShippingTabs() {
  const t = useT('shippingHub.tabs');
  const params = useParams();
  const pathname = usePathname() ?? '';
  const storeId = params?.id as string;
  const { isEnabled } = useFeatures();
  const base = `/stores/${storeId}`;

  const tabs = [
    { href: `${base}/shipping`, label: t('rates') },
    ...(isEnabled('shipping_carriers')
      ? [{ href: `${base}/shipping-carriers`, label: t('carriers') }]
      : []),
    { href: `${base}/delivery`, label: t('delivery') },
    { href: `${base}/cod-reconciliation`, label: t('cod') },
  ];

  return (
    <nav aria-label={t('label')} className="-mt-1 mb-6 overflow-x-auto border-b border-border">
      <ul className="flex min-w-max gap-1">
        {tabs.map(tab => {
          const active = pathname === tab.href || pathname.startsWith(`${tab.href}/`);
          return (
            <li key={tab.href}>
              <Link
                href={tab.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'inline-flex min-h-11 items-center border-b-2 px-4 text-sm font-medium transition-colors',
                  active
                    ? 'border-primary text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                )}
              >
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
