'use client';

/**
 * Breadcrumbs — the ONE storefront trail (R-06, quality-bar § 3). The PDP had a
 * slash AND a chevron with no semantics, the PLP an un-mirrored chevron, the cart
 * a third grammar; bundles and Dahab their own.
 *
 * `nav[aria-label] > ol > li`; the separator is one chevron that mirrors in RTL
 * (`rtl:-scale-x-100`) and is hidden from assistive tech; the last crumb is the
 * current page (`aria-current="page"`, not a link).
 */
import Link from 'next/link';
import type { CSSProperties, ReactNode } from 'react';
import { useLanguage } from '../contexts/LanguageContext';

export interface Crumb {
  label: ReactNode;
  /** Omitted on the last crumb: the current page is not a link. */
  href?: string;
  onClick?: () => void;
}

export function Breadcrumbs({
  items,
  className = 'mb-6 text-sm',
  style,
  currentStyle,
}: {
  items: Crumb[];
  /** Spacing, size and visibility of the trail (default `mb-6 text-sm`). */
  className?: string;
  /** Merchant colour / zone style for the whole trail (PLP). */
  style?: CSSProperties;
  /** Same, for the current crumb (it is ink, not muted, by default). */
  currentStyle?: CSSProperties;
}) {
  const { t } = useLanguage();
  if (items.length === 0) return null;
  return (
    <nav
      aria-label={t('Breadcrumb', 'مسار التصفح')}
      className={`text-muted-foreground ${className}`}
      style={style}
    >
      <ol className="flex flex-wrap items-center gap-1.5">
        {items.map((item, i) => {
          const last = i === items.length - 1;
          return (
            <li key={i} className="inline-flex min-w-0 items-center gap-1.5">
              {i > 0 && (
                <svg
                  aria-hidden="true"
                  data-breadcrumb-separator
                  className="h-3.5 w-3.5 shrink-0 rtl:-scale-x-100"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M9 5l7 7-7 7"
                  />
                </svg>
              )}
              {last || !item.href ? (
                <span
                  aria-current={last ? 'page' : undefined}
                  className={last ? 'line-clamp-1 text-foreground' : undefined}
                  style={last ? currentStyle : undefined}
                >
                  {item.label}
                </span>
              ) : (
                <Link
                  href={item.href}
                  onClick={item.onClick}
                  // P2-10: a 44px hit area, the trail keeps its 20px line.
                  className="relative transition-colors before:absolute before:-inset-x-2 before:-inset-y-3 before:content-[''] hover:text-primary"
                >
                  {item.label}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
