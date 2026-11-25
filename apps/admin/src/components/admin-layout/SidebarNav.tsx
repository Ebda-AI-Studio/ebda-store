'use client';

import Link from 'next/link';
import { navItemClasses } from '../ui/tokens';
import type { NavItem } from './buildStoreAdminNav';
import { AttentionBadge } from '../attention/AttentionBadge';

interface SidebarNavProps {
  navItems: NavItem[];
  pathname: string | null;
  onNavigate: () => void;
  /**
   * When provided, a nav item is considered active if its `hubKey` matches
   * this value. This ensures the Catalog hub item stays highlighted when
   * browsing /blog or /builder even though the item's href points to
   * /products.
   */
  activeHubKey?: string | null;
  /** Action-needed count per hubKey (the Settings item shows the store's "needs attention" count). */
  badges?: Record<string, number>;
}

export function SidebarNav({
  navItems,
  pathname,
  onNavigate,
  activeHubKey,
  badges,
}: SidebarNavProps) {
  return (
    <nav className="flex-1 overflow-y-auto px-3 py-4">
      <ul className="space-y-1">
        {navItems.map(item => {
          // Hub-aware active detection: if the item carries a hubKey and the
          // current hub matches, mark it active regardless of the exact URL.
          // Falls back to the original pathname-prefix check for super-admin
          // nav items that don't have a hubKey.
          const isActive = item.hubKey
            ? activeHubKey === item.hubKey
            : pathname === item.href || (item.href !== '/' && pathname?.startsWith(item.href));

          return (
            <li key={item.name}>
              <Link
                data-ui="nav"
                href={item.href}
                onClick={onNavigate}
                className={navItemClasses({
                  kind: 'sidebar',
                  active: !!isActive,
                  className: 'group',
                })}
                aria-current={isActive ? 'page' : undefined}
              >
                {/* Start-side active indicator */}
                {isActive && (
                  <span className="absolute start-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-full bg-primary" />
                )}
                <span className="flex h-8 w-8 items-center justify-center rounded-md">
                  <svg
                    className="h-4 w-4"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    aria-hidden="true"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={1.5}
                      d={item.icon}
                    />
                  </svg>
                </span>
                <span className="flex-1">{item.name}</span>
                {item.hubKey && badges?.[item.hubKey] ? (
                  <AttentionBadge count={badges[item.hubKey]} />
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
