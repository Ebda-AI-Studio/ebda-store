'use client';

import { useT } from '@/i18n/useT';
import type { OrderDetail } from './types';

interface PlatformCardProps {
  /** `order.source` ('web' | 'agent' | undefined/null → treated as 'web'). */
  order: Pick<OrderDetail, 'source'>;
}

/**
 * Order provenance card. Renders "Web" (default, globe icon) for ordinary
 * checkout, or "Agent" (robot icon) when `order.source === 'agent'` — the
 * order was placed by an AI agent via the MCP `place_order` tool
 * (every-data-needs-a-UI surface for `Order.source`).
 */
export function PlatformCard({ order }: PlatformCardProps) {
  const t = useT('orders.detail');
  const isAgent = order.source === 'agent';

  return (
    <section className="rounded-lg border border-border bg-card p-5">
      <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide mb-4">
        {t('platform')}
      </h2>
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
          {isAgent ? (
            <svg
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              aria-hidden
            >
              <rect x="4" y="8" width="16" height="12" rx="2" strokeWidth={2} />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 8V4m-3 0h6"
              />
              <circle cx="9" cy="14" r="1.25" fill="currentColor" stroke="none" />
              <circle cx="15" cy="14" r="1.25" fill="currentColor" stroke="none" />
            </svg>
          ) : (
            <svg
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              aria-hidden
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064"
              />
              <circle
                cx="12"
                cy="12"
                r="9"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
              />
            </svg>
          )}
        </div>
        <span className="font-semibold text-foreground">{isAgent ? t('agent') : t('web')}</span>
      </div>
    </section>
  );
}
