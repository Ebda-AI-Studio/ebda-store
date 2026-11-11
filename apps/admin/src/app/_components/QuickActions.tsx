'use client';

import Link from 'next/link';
import { useT } from '@/i18n/useT';

export function QuickActions() {
  const t = useT('dashboard.super');

  const actions = [
    {
      title: t('qaCreateStoreTitle'),
      description: t('qaCreateStoreDesc'),
      href: '/stores/new',
      icon: 'M12 4v16m8-8H4',
      iconBg: 'bg-info/10 text-info-ink dark:bg-info/30 dark:text-info-ink',
    },
    {
      title: t('qaManageUsersTitle'),
      description: t('qaManageUsersDesc'),
      href: '/users',
      icon: 'M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z',
      iconBg: 'bg-success/10 text-success-ink',
    },
    {
      title: t('qaAuditLogsTitle'),
      description: t('qaAuditLogsDesc'),
      href: '/audit-logs',
      icon: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
      iconBg: 'bg-primary/10 text-primary-ink',
    },
    {
      title: t('qaAllStoresTitle'),
      description: t('qaAllStoresDesc'),
      href: '/stores',
      icon: 'M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4',
      iconBg: 'bg-muted text-muted-foreground',
    },
  ];

  return (
    <div className="mt-8 animate-slide-up" style={{ animationDelay: '0.4s' }}>
      <div className="mb-4">
        <h2 className="text-lg font-semibold text-foreground">{t('quickActionsTitle')}</h2>
        <p className="text-sm text-muted-foreground">{t('quickActionsSubtitle')}</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {actions.map((action, index) => (
          <Link
            key={action.title}
            href={action.href}
            className="group force-card flex items-center gap-4 p-4"
            style={{ animationDelay: `${0.5 + index * 0.05}s` }}
          >
            <div
              className={`flex h-12 w-12 items-center justify-center rounded-xl ${action.iconBg} transition-transform group-hover:scale-110`}
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d={action.icon}
                />
              </svg>
            </div>
            <div>
              <p className="font-medium text-foreground group-hover:text-primary transition-colors">
                {action.title}
              </p>
              <p className="text-xs text-muted-foreground">{action.description}</p>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
