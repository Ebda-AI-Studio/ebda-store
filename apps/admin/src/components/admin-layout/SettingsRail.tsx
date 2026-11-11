'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useT } from '@/i18n/useT';
import { useFeatures } from '../../hooks/useFeatures';
import { navFeatureState } from '../../lib/nav-lock';
import { LockBadge } from './LockBadge';
import { SETTINGS_GROUPS } from '../../lib/settings-groups';

/**
 * Inline-start rail of the Settings hub (UX:N-3): the same five groups as the hub page, on every settings page, so
 * moving between "الشحن" and "الدفع" is one click instead of back-to-hub-then-forward. Large screens only; on
 * phones the TopBar breadcrumb returns to the hub.
 */
export function SettingsRail({ storeId }: { storeId: string }) {
  const t = useT('settings');
  const tCards = useT('settings.cards');
  const pathname = usePathname() ?? '';
  const { isEnabled, isLoading } = useFeatures();
  const ctx = { isEnabled, isLoading, isSuperAdmin: false };
  const base = `/stores/${storeId}`;

  return (
    <nav aria-label={t('rail.label')} className="hidden w-56 shrink-0 lg:block">
      <div className="sticky top-20 space-y-5">
        <Link
          href={`${base}/settings`}
          className="block text-sm font-semibold text-foreground hover:text-primary"
        >
          {t('rail.allSettings')}
        </Link>
        {SETTINGS_GROUPS.map(group => {
          const items = group.items.filter(i => navFeatureState(i.featureKey, ctx) !== 'hidden');
          if (items.length === 0) return null;
          return (
            <div key={group.key}>
              <p className="mb-1 text-xs font-medium text-muted-foreground">
                {t(`groups.${group.key}`)}
              </p>
              <ul className="space-y-0.5">
                {items.map(i => {
                  const href = `${base}/${i.path}`;
                  const active = pathname === href || pathname.startsWith(`${href}/`);
                  return (
                    <li key={i.card}>
                      <Link
                        data-ui="nav"
                        href={href}
                        aria-current={active ? 'page' : undefined}
                        className={`flex min-h-9 items-center rounded-lg px-2 text-sm transition-colors ${
                          active
                            ? 'bg-primary/10 font-medium text-primary-ink'
                            : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                        }`}
                      >
                        {tCards(`${i.card}.title`)}
                        {navFeatureState(i.featureKey, ctx) === 'locked' && <LockBadge />}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
    </nav>
  );
}
