'use client';

import { forwardRef } from 'react';
import { cn } from '../utils/cn';

export interface BreadcrumbItem {
  id: string;
  label: string;
  labelAr?: string;
  href?: string;
  isCurrent?: boolean;
}

export interface BreadcrumbProps extends React.HTMLAttributes<HTMLElement> {
  /** Breadcrumb items */
  items: BreadcrumbItem[];
  /** Show in RTL format */
  isRtl?: boolean;
  /** Separator style */
  separator?: 'chevron' | 'slash' | 'dot' | 'arrow';
  /** Size variant */
  size?: 'sm' | 'md' | 'lg';
  /** Show home icon as first item */
  showHomeIcon?: boolean;
  /** Custom home label */
  homeLabel?: string;
  /** Maximum items to show before collapsing */
  maxItems?: number;
  /** Link component for Next.js Link or custom routing */
  LinkComponent?: React.ComponentType<{ href: string; className?: string; children: React.ReactNode }>;
}

const sizeStyles = {
  sm: 'text-xs gap-1.5',
  md: 'text-sm gap-2',
  lg: 'text-base gap-2.5',
};

const separatorIcons = {
  chevron: (isRtl: boolean) => (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d={isRtl ? 'M15 19l-7-7 7-7' : 'M9 5l7 7-7 7'}
      />
    </svg>
  ),
  slash: () => <span className="text-muted-foreground/50">/</span>,
  dot: () => <span className="w-1 h-1 rounded-full bg-muted-foreground/50" />,
  arrow: (isRtl: boolean) => (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d={isRtl ? 'M19 12H5m7-7l-7 7 7 7' : 'M5 12h14m-7-7l7 7-7 7'}
      />
    </svg>
  ),
};

const HomeIcon = () => (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"
    />
  </svg>
);

/**
 * Breadcrumb navigation for showing page hierarchy.
 */
export const Breadcrumb = forwardRef<HTMLElement, BreadcrumbProps>(
  (
    {
      items,
      isRtl = false,
      separator = 'chevron',
      size = 'md',
      showHomeIcon = true,
      homeLabel,
      maxItems,
      LinkComponent,
      className,
      ...props
    },
    ref
  ) => {
    // Default anchor link if no custom component provided
    const Link = LinkComponent || (({ href, className, children }: { href: string; className?: string; children: React.ReactNode }) => (
      <a href={href} className={className}>{children}</a>
    ));

    const renderSeparator = () => {
      const SeparatorIcon = separatorIcons[separator];
      return (
        <span className="text-muted-foreground flex items-center" aria-hidden="true">
          {typeof SeparatorIcon === 'function' ? SeparatorIcon(isRtl) : SeparatorIcon}
        </span>
      );
    };

    // Handle item collapsing
    let displayItems = items;

    if (maxItems && items.length > maxItems) {
      const start = items.slice(0, 1);
      const end = items.slice(-(maxItems - 2));
      displayItems = [...start, { id: 'collapsed', label: '...', labelAr: '...' }, ...end];
    }

    return (
      <nav
        ref={ref}
        aria-label={isRtl ? 'مسار التنقل' : 'Breadcrumb'}
        className={cn('flex items-center flex-wrap', sizeStyles[size], className)}
        dir={isRtl ? 'rtl' : 'ltr'}
        {...props}
      >
        <ol className={cn('flex items-center flex-wrap', sizeStyles[size])}>
          {displayItems.map((item, index) => {
            const isFirst = index === 0;
            const isLast = index === displayItems.length - 1;
            const isCollapsed = item.id === 'collapsed';
            const label = isRtl && item.labelAr ? item.labelAr : item.label;

            return (
              <li key={item.id} className="flex items-center">
                {/* Separator (not before first item) */}
                {!isFirst && renderSeparator()}

                {/* Item Content */}
                {isCollapsed ? (
                  <span className="px-1 text-muted-foreground">...</span>
                ) : item.isCurrent || isLast || !item.href ? (
                  <span
                    className={cn(
                      'font-medium',
                      isLast || item.isCurrent
                        ? 'text-foreground'
                        : 'text-muted-foreground'
                    )}
                    aria-current={item.isCurrent || isLast ? 'page' : undefined}
                  >
                    {isFirst && showHomeIcon ? (
                      <span className="flex items-center gap-1.5">
                        <HomeIcon />
                        {homeLabel || label}
                      </span>
                    ) : (
                      label
                    )}
                  </span>
                ) : (
                  <Link
                    href={item.href}
                    className={cn(
                      'text-muted-foreground hover:text-foreground transition-colors',
                      'focus:outline-none focus:underline'
                    )}
                  >
                    {isFirst && showHomeIcon ? (
                      <span className="flex items-center gap-1.5">
                        <HomeIcon />
                        {homeLabel || label}
                      </span>
                    ) : (
                      label
                    )}
                  </Link>
                )}
              </li>
            );
          })}
        </ol>
      </nav>
    );
  }
);

Breadcrumb.displayName = 'Breadcrumb';

/**
 * Generate Schema.org structured data object for breadcrumbs (SEO).
 * Use this in your page component with Next.js metadata or a script tag.
 */
export function generateBreadcrumbSchema(items: BreadcrumbItem[], baseUrl: string) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.label,
      item: item.href ? `${baseUrl}${item.href}` : undefined,
    })),
  };
}
