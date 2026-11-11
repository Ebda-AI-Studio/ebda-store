'use client';

import Link from 'next/link';
import type { NavItem } from './buildStoreAdminNav';

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
}

export function SidebarNav({ navItems, pathname, onNavigate, activeHubKey }: SidebarNavProps) {
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
                className={`group relative flex min-h-11 items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition-all duration-200 ${
                  isActive
                    ? 'bg-primary/10 text-primary-ink'
                    : 'text-muted-foreground hover:bg-muted/70 hover:text-foreground'
                }`}
                aria-current={isActive ? 'page' : undefined}
              >
                {/* Start-side active indicator */}
                {isActive && (
                  <span className="absolute start-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-full bg-primary" />
                )}
                <span
                  className={`flex h-8 w-8 items-center justify-center rounded-lg transition-all duration-200 ${
                    isActive
                      ? 'bg-primary/15 text-primary-ink'
                      : 'text-muted-foreground group-hover:bg-muted group-hover:text-foreground'
                  }`}
                >
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
                <span className={isActive ? 'font-semibold' : ''}>{item.name}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
