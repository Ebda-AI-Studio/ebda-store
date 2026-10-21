'use client';

import Link from 'next/link';
import { useParams, usePathname } from 'next/navigation';
import { useT } from '@/i18n/useT';
import { useFeatures } from '../../hooks/useFeatures';
import { useWholesalePending } from '../../hooks/useWholesalePending';

export interface HubTab {
  label: string;
  href: string;
  /**
   * When set, the tab is shown ONLY once the store's feature map has loaded
   * and this feature is on — never while loading (the features context
   * defaults to "enabled" while loading, which would flash the tab). Used for
   * tabs that must not appear at all for stores without the feature
   * (e.g. the customer wallet, OFF for every store at launch). Tabs without a
   * key keep the older "tab always renders, the page gates" behaviour.
   */
  featureKey?: string;
  /**
   * Shows a count badge on the tab. 'wholesalePending' = the wholesale applications waiting for the merchant
   * (B2B review I5); the badge renders only while the count is above 0 and the store is on the plan.
   */
  badgeKey?: 'wholesalePending';
}

interface Props {
  items: HubTab[];
}

/**
 * Horizontal tab bar rendered above page content when inside a multi-route hub
 * (Catalog, Sales, Stock, Finance, Marketing). Dashboard, Analytics, and
 * Settings have a single route and render no tabs.
 *
 * Active tab uses longest-prefix matching so that `/stock/inventory` correctly
 * highlights the Inventory tab over the Overview tab.
 */
export function HubTabs({ items }: Props) {
  const pathname = usePathname();
  const tr = useT('components.adminLayout');
  const params = useParams();
  const { isEnabled, isLoading: featuresLoading } = useFeatures();
  const wantsBadge = items.some(i => i.badgeKey === 'wholesalePending');
  const pending = useWholesalePending(
    params?.id as string | undefined,
    wantsBadge && !featuresLoading && isEnabled('b2b.wholesale')
  );
  const pendingCount = pending?.pendingCount ?? 0;

  // Active tab: longest href prefix that matches the current pathname.
  const active = items.reduce<string | null>((best, t) => {
    if (pathname === t.href || pathname.startsWith(t.href + '/')) {
      if (!best || t.href.length > best.length) return t.href;
    }
    return best;
  }, null);

  return (
    <div className="border-b border-border bg-background sticky top-0 z-10">
      <nav
        className="flex gap-1 overflow-x-auto px-4 py-1 text-sm"
        aria-label={tr('hubSectionsAriaLabel')}
      >
        {items.map(t => (
          <Link
            key={t.href}
            href={t.href}
            className={
              /* min-h-11 = 44px satisfies Apple HIG / WCAG 2.5.5 touch target on mobile;
                 md:min-h-9 relaxes to 36px on desktop to keep the tab bar compact. */
              'inline-flex items-center px-3 min-h-11 md:min-h-9 rounded-md whitespace-nowrap transition-colors ' +
              (active === t.href
                ? 'bg-primary text-primary-foreground font-medium'
                : 'hover:bg-muted text-muted-foreground hover:text-foreground')
            }
          >
            {t.label}
            {t.badgeKey === 'wholesalePending' && pendingCount > 0 ? (
              <span
                data-testid="wholesale-pending-badge"
                aria-label={tr('wholesalePendingBadge', { count: pendingCount })}
                className={
                  'ms-1.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-xs font-semibold tabular-nums ' +
                  (active === t.href
                    ? 'bg-primary-foreground text-primary'
                    : 'bg-primary text-primary-foreground')
                }
              >
                {pendingCount > 99 ? '99+' : pendingCount}
              </span>
            ) : null}
          </Link>
        ))}
      </nav>
    </div>
  );
}
