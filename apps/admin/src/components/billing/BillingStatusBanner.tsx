'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useLocale } from 'next-intl';
import { apiGet } from '../../lib/api';
import { useT } from '../../i18n/useT';
import { billingNotice, noticeText } from './notice';
import { SupportLink } from './SupportLink';
import type { BillingInfo } from './types';

/**
 * One-line, store-wide billing banner (suspension, overdue, due within 7
 * days) linking to the billing page. Fetches the billing state once per store
 * id; stays hidden on the billing page, which shows the full notice itself.
 */
export function BillingStatusBanner({ storeId }: { storeId: string }) {
  const t = useT('billing.notice');
  const locale = useLocale() === 'ar' ? 'ar' : 'en';
  const pathname = usePathname() ?? '';
  const [billing, setBilling] = useState<{ storeId: string; info: BillingInfo } | null>(null);

  useEffect(() => {
    if (!storeId) return;
    let cancelled = false;
    void apiGet<{ billing?: BillingInfo }>(`/api/v1/stores/${storeId}/billing`).then(({ data }) => {
      if (!cancelled && data?.billing) setBilling({ storeId, info: data.billing });
    });
    return () => {
      cancelled = true;
    };
  }, [storeId]);

  if (pathname.endsWith('/billing')) return null;
  const info = billing?.storeId === storeId ? billing.info : null;
  const kind = billingNotice(info);
  if (!info || !kind) return null;

  const { title } = noticeText(kind, info, t, locale);
  const urgent =
    kind === 'unpaid' || kind === 'overdue' || kind === 'graceEnding' || kind === 'overStoreLimit';
  return (
    <div
      role={urgent ? 'alert' : 'status'}
      className={`flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-2 text-sm lg:ms-72 ${
        urgent ? 'bg-destructive/10 text-destructive-ink' : 'bg-warning/10 text-warning-ink'
      }`}
    >
      <span>{title}</span>
      <span className="flex flex-wrap gap-x-4">
        <Link href={`/stores/${storeId}/billing`} className="font-medium underline">
          {t('view')}
        </Link>
        {urgent && <SupportLink whatsappUrl={info.supportWhatsappUrl} email={info.supportEmail} />}
      </span>
    </div>
  );
}
