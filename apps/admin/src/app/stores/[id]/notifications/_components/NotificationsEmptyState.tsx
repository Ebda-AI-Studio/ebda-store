'use client';

import { buttonVariants } from '@/components/ui/Button';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useT } from '@/i18n/useT';

/**
 * Rendered when none of sms / push_notifications features are
 * enabled for the store. Includes a direct CTA to the per-store features
 * editor so super admins (the only role that gets this far without being
 * redirected to the dashboard) can flip a channel on without hunting
 * through the nav.
 */
export function NotificationsEmptyState() {
  const t = useT('notifications.empty');
  const params = useParams();
  const storeId = params?.id as string | undefined;

  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <div className="w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center mb-4">
        <svg className="w-8 h-8 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
          />
        </svg>
      </div>
      <h2 className="text-xl font-semibold text-foreground mb-2">{t('title')}</h2>
      <p className="text-muted-foreground max-w-md">{t('description')}</p>
      {storeId && (
        <Link
          href={`/stores/${storeId}/features`}
          className={buttonVariants({ className: 'mt-6 gap-2' })}
        >
          {t('ctaEnable')} →
        </Link>
      )}
    </div>
  );
}
