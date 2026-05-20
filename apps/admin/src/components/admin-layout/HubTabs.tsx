'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export interface HubTab {
  label: string;
  href: string;
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

  // Active tab: longest href prefix that matches the current pathname.
  const active = items.reduce<string | null>((best, t) => {
    if (pathname === t.href || pathname.startsWith(t.href + '/')) {
      if (!best || t.href.length > best.length) return t.href;
    }
    return best;
  }, null);

  return (
    <div className="border-b border-border bg-background sticky top-0 z-10">
      <nav className="flex gap-1 overflow-x-auto px-4 py-2 text-sm" aria-label="Hub sections">
        {items.map(t => (
          <Link
            key={t.href}
            href={t.href}
            className={
              'px-3 py-1.5 rounded-md whitespace-nowrap transition-colors ' +
              (active === t.href
                ? 'bg-primary text-primary-foreground font-medium'
                : 'hover:bg-muted text-muted-foreground hover:text-foreground')
            }
          >
            {t.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
