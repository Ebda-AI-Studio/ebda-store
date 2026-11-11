'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Badge } from '@ebda/ui';
import { Button } from '@/components/ui/Button';
import { AdminLayout } from '../../../../components/AdminLayout';
import { Alert } from '../../../../components/Alert';
import { apiGet } from '../../../../lib/api';
import { getPlatformStoreUrl, getStoreDisplayUrl } from '../../../../lib/store-url';
import { useT } from '@/i18n/useT';
import { DataTable, type DataTableColumn } from '@/components/mobile/DataTable';
import type { CreatedOwner, CreatedStore, DomainStatus } from './types';
import { BRAND } from '@ebda/shared';

interface DnsRecordRow {
  type: string;
  name: string;
  value: string;
}

interface SuccessScreenProps {
  store: CreatedStore;
  owner: CreatedOwner;
}

export function SuccessScreen({ store, owner }: SuccessScreenProps) {
  const t = useT('stores.new');
  const [domainStatus, setDomainStatus] = useState<DomainStatus | null>(null);
  const [isCheckingDns, setIsCheckingDns] = useState(false);

  // Same fallback semantics as the original `.map() || fallback`: only shown
  // when the API returned no records at all (undefined/null), not an empty array.
  const dnsRows: DnsRecordRow[] = domainStatus?.dnsRecords ?? [
    { type: 'CNAME', name: store.domain ?? '', value: `cf${BRAND.domains.storeSuffix}` },
  ];
  const dnsColumns: DataTableColumn<DnsRecordRow>[] = [
    {
      header: t('colType'),
      mobileBadge: true,
      className: 'whitespace-nowrap',
      cell: record => <span className="font-mono text-xs">{record.type}</span>,
    },
    {
      header: t('colName'),
      primaryOnMobile: true,
      className: 'whitespace-nowrap',
      cell: record => <span className="font-mono text-xs">{record.name}</span>,
    },
    {
      header: t('colValue'),
      cell: record => <span className="font-mono text-xs break-all">{record.value}</span>,
    },
  ];

  const checkDomainStatus = useCallback(async (storeId: string) => {
    setIsCheckingDns(true);
    try {
      const { data } = await apiGet<DomainStatus>(`/api/v1/stores/${storeId}/domain`);
      if (data) {
        setDomainStatus(data);
      }
    } catch {
      // Silently fail — DNS check is non-critical
    } finally {
      setIsCheckingDns(false);
    }
  }, []);

  // Auto-check DNS on mount if a custom domain was provided
  useEffect(() => {
    if (store.domain) {
      checkDomainStatus(store.id);
    }
  }, [store.domain, store.id, checkDomainStatus]);

  return (
    <AdminLayout title={t('successTitle')} subtitle={t('successSubtitle')}>
      <div className="mx-auto max-w-2xl">
        <div className="rounded-xl border bg-card p-8 shadow-sm text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-success/10">
            <svg
              className="h-8 w-8 text-success-ink"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M5 13l4 4L19 7"
              />
            </svg>
          </div>
          <h2 className="mt-4 text-2xl font-bold text-foreground">{t('successHeading')}</h2>
          <p className="mt-2 text-muted-foreground">{t('successMessage', { name: store.name })}</p>

          <div className="mt-6 rounded-lg bg-muted p-4 text-start">
            <h3 className="font-semibold text-foreground">{t('storeDetails')}</h3>
            <dl className="mt-2 space-y-1 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted-foreground">{t('storeUrl')}</dt>
                <dd className="font-medium">{getStoreDisplayUrl(store)}</dd>
              </div>
              {store.domain && (
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">{t('defaultUrl')}</dt>
                  <dd className="font-medium text-muted-foreground">
                    {getPlatformStoreUrl(store.slug)}
                  </dd>
                </div>
              )}
              <div className="flex justify-between">
                <dt className="text-muted-foreground">{t('ownerEmail')}</dt>
                <dd className="font-medium">{owner.email}</dd>
              </div>
              {owner.temporaryPassword && (
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">{t('tempPassword')}</dt>
                  <dd className="font-mono font-medium text-primary">{owner.temporaryPassword}</dd>
                </div>
              )}
            </dl>
          </div>

          {/* DNS Instructions (shown when custom domain was provided) */}
          {store.domain && (
            <Alert
              className="mt-6 text-start"
              variant="warning"
              title={
                <span className="flex items-center justify-between gap-3">
                  <span>{t('dnsRequired')}</span>
                  <Badge variant={domainStatus?.verified ? 'default' : 'secondary'}>
                    {domainStatus?.verified ? t('dnsVerified') : t('dnsPending')}
                  </Badge>
                </span>
              }
            >
              <p className="mt-2 text-sm">{t('dnsInstructions')}</p>
              <div className="mt-3">
                <DataTable<DnsRecordRow>
                  ariaLabel={t('dnsTableLabel')}
                  columns={dnsColumns}
                  rows={dnsRows}
                  rowKey={(record, i) => `${record.type}-${record.name}-${i}`}
                />
              </div>
              <div className="mt-3 flex items-center justify-between">
                <p className="text-xs opacity-80">{t('dnsPropagation')}</p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => checkDomainStatus(store.id)}
                  disabled={isCheckingDns}
                >
                  {isCheckingDns ? t('checkingDns') : t('checkDns')}
                </Button>
              </div>
            </Alert>
          )}

          <div className="mt-8 flex justify-center gap-4">
            <Link href={`/stores/${store.id}`}>
              <Button>{t('viewStore')}</Button>
            </Link>
            <Link href="/stores">
              <Button variant="outline">{t('backToStores')}</Button>
            </Link>
          </div>
        </div>
      </div>
    </AdminLayout>
  );
}
