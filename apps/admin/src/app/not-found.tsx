'use client';

import { buttonVariants } from '@/components/ui/Button';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { BRAND_MARKETING_URL } from '@ebda/shared';
import { SettingsSearch } from '@/components/SettingsSearch';
import { useT } from '@/i18n/useT';

/** The store a missing URL was under (`/stores/<uuid>/...`), when it was under one. */
function storeIdOf(pathname: string | null): string {
  return /^\/stores\/([0-9a-f-]{36})(\/|$)/i.exec(pathname ?? '')?.[1] ?? '';
}

/**
 * The admin's calm 404: one sentence, the live settings / page search (the same registry as the Settings
 * page and the command palette), and the merchant's own quick links. The HTTP status is Next's 404.
 */
export default function NotFound() {
  const t = useT('common.errors.notFound');
  const storeId = storeIdOf(usePathname());
  const links = storeId
    ? [
        { href: '/dashboard', label: t('linkDashboard') },
        { href: `/stores/${storeId}/products`, label: t('linkProducts') },
        { href: `/stores/${storeId}/orders`, label: t('linkOrders') },
        { href: `/stores/${storeId}/customers`, label: t('linkCustomers') },
        { href: `/stores/${storeId}/settings`, label: t('linkSettings') },
        { href: '/stores', label: t('linkStores') },
      ]
    : [
        { href: '/dashboard', label: t('linkDashboard') },
        { href: '/stores', label: t('linkStores') },
      ];
  return (
    <div className="mx-auto flex min-h-[60vh] w-full max-w-xl flex-col justify-center gap-8 px-4 py-12">
      <div className="space-y-2">
        <h1 className="text-balance text-2xl font-semibold text-foreground sm:text-3xl">
          {t('line')}
        </h1>
        {storeId && <p className="text-muted-foreground">{t('hint')}</p>}
      </div>
      {storeId && <SettingsSearch storeId={storeId} />}
      <nav aria-label={t('quickLinks')} className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground">{t('quickLinks')}</h2>
        <ul className="flex flex-wrap gap-2">
          {links.map(l => (
            <li key={l.href}>
              <Link href={l.href} className={buttonVariants({ variant: 'outline' })}>
                {l.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <a
        href={BRAND_MARKETING_URL}
        className="text-sm text-muted-foreground underline underline-offset-4"
      >
        {t('backToSite')}
      </a>
    </div>
  );
}
