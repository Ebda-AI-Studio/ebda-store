'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { Button, Badge, Input, Label } from '@force/ui';
import { AdminLayout } from '../../../../components/AdminLayout';
import { apiGet, apiPut } from '../../../../lib/api';
import { useCurrentStore } from '../../../../hooks/useCurrentStore';
import { useT } from '@/i18n/useT';

export default function StoreDomainPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const t = useT('domain.page');
  const { store, isLoading, refetch: refetchStore } = useCurrentStore(storeId);

  // ----- Domain section state -----
  const [isEditing, setIsEditing] = useState(false);
  const [newDomain, setNewDomain] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isChecking, setIsChecking] = useState(false);
  const [domainStatus, setDomainStatus] = useState<{
    domain: string;
    verified: boolean;
    misconfigured: boolean;
    dnsRecords: Array<{ type: string; name: string; value: string }>;
  } | null>(null);
  const [domainError, setDomainError] = useState('');

  const checkDns = useCallback(async () => {
    if (!store?.domain) return;
    setIsChecking(true);
    try {
      const { data } = await apiGet<{
        domain: string;
        verified: boolean;
        misconfigured: boolean;
        dnsRecords: Array<{ type: string; name: string; value: string }>;
      }>(`/api/v1/stores/${storeId}/domain`);
      if (data) setDomainStatus(data);
    } catch {
      // non-critical
    } finally {
      setIsChecking(false);
    }
  }, [store?.domain, storeId]);

  useEffect(() => {
    if (store?.domain) checkDns();
  }, [store?.domain, checkDns]);

  async function handleSaveDomain() {
    const trimmed = newDomain.trim().toLowerCase();
    if (
      trimmed &&
      !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(trimmed)
    ) {
      setDomainError(t('invalidDomain'));
      return;
    }
    setIsSaving(true);
    setDomainError('');
    try {
      const { error: apiError } = await apiPut(`/api/v1/stores/${storeId}/domain`, {
        domain: trimmed || null,
      });
      if (!apiError) {
        setIsEditing(false);
        await refetchStore();
        if (trimmed) setTimeout(checkDns, 1000);
        else setDomainStatus(null);
      } else {
        setDomainError(apiError.message || t('updateFailed'));
      }
    } catch {
      setDomainError(t('updateFailed'));
    } finally {
      setIsSaving(false);
    }
  }

  async function handleRemoveDomain() {
    setNewDomain('');
    setIsSaving(true);
    try {
      const { error: apiError } = await apiPut(`/api/v1/stores/${storeId}/domain`, {
        domain: null,
      });
      if (!apiError) {
        setDomainStatus(null);
        setIsEditing(false);
        await refetchStore();
      }
    } catch {
      // non-critical
    } finally {
      setIsSaving(false);
    }
  }

  if (isLoading) {
    return (
      <AdminLayout title={t('title')} subtitle={t('subtitle')} mode="store_admin" storeId={storeId}>
        <div className="mx-auto max-w-4xl p-6">
          <div className="h-64 animate-pulse rounded-xl bg-muted" />
        </div>
      </AdminLayout>
    );
  }

  if (!store) {
    return (
      <AdminLayout title={t('title')} subtitle={t('subtitle')} mode="store_admin" storeId={storeId}>
        <div className="mx-auto max-w-4xl p-6">
          <p className="text-muted-foreground">{t('storeNotFound')}</p>
        </div>
      </AdminLayout>
    );
  }

  const domain = store.domain;

  return (
    <AdminLayout title={t('title')} subtitle={t('subtitle')} mode="store_admin" storeId={storeId}>
      <div className="mx-auto max-w-4xl p-6">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-foreground">{t('heading')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>

        <div className="rounded-xl border bg-card shadow-sm">
          <div className="flex items-center justify-between border-b p-4">
            <h2 className="font-semibold text-foreground">
              {store.name} {t('storeDomainSuffix')}
            </h2>
            <div className="flex gap-2">
              {!isEditing && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setNewDomain(domain || '');
                    setIsEditing(true);
                    setDomainError('');
                  }}
                >
                  {domain ? t('changeDomain') : t('addDomain')}
                </Button>
              )}
              {domain && !isEditing && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleRemoveDomain}
                  disabled={isSaving}
                >
                  {t('remove')}
                </Button>
              )}
            </div>
          </div>
          <div className="p-6">
            {isEditing ? (
              <div className="space-y-4">
                <div>
                  <Label htmlFor="domain">{t('domain')}</Label>
                  <Input
                    id="domain"
                    value={newDomain}
                    onChange={e => {
                      setNewDomain(e.target.value.toLowerCase());
                      setDomainError('');
                    }}
                    placeholder={t('domainPlaceholder')}
                    className={`mt-1 ${domainError ? 'border-destructive' : ''}`}
                  />
                  {domainError && <p className="mt-1 text-sm text-destructive">{domainError}</p>}
                  <p className="mt-1 text-xs text-muted-foreground">{t('domainRemoveHint')}</p>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" onClick={handleSaveDomain} disabled={isSaving}>
                    {isSaving ? t('saving') : t('save')}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setIsEditing(false);
                      setDomainError('');
                    }}
                  >
                    {t('cancel')}
                  </Button>
                </div>
              </div>
            ) : domain ? (
              <div className="space-y-4">
                <div className="flex items-center gap-3">
                  <p className="font-medium text-foreground">{domain}</p>
                  <Badge variant={domainStatus?.verified ? 'default' : 'secondary'}>
                    {domainStatus?.verified ? t('verified') : t('pending')}
                  </Badge>
                </div>

                {!domainStatus?.verified && (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
                    <p className="text-sm font-medium text-amber-900">{t('dnsRequired')}</p>
                    <p className="mt-1 text-sm text-amber-800">{t('dnsInstructions')}</p>
                    <div className="mt-3 overflow-hidden rounded-md border border-amber-200 bg-white">
                      <table className="w-full text-sm" aria-label={t('dnsTableLabel')}>
                        <thead>
                          <tr className="border-b bg-amber-50">
                            <th
                              scope="col"
                              className="px-3 py-2 text-start font-medium text-amber-900"
                            >
                              {t('colType')}
                            </th>
                            <th
                              scope="col"
                              className="px-3 py-2 text-start font-medium text-amber-900"
                            >
                              {t('colName')}
                            </th>
                            <th
                              scope="col"
                              className="px-3 py-2 text-start font-medium text-amber-900"
                            >
                              {t('colValue')}
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {domainStatus?.dnsRecords?.map((record, i) => (
                            <tr key={i} className="border-b last:border-0">
                              <td className="px-3 py-2 font-mono text-xs">{record.type}</td>
                              <td className="px-3 py-2 font-mono text-xs">{record.name}</td>
                              <td className="px-3 py-2 font-mono text-xs">{record.value}</td>
                            </tr>
                          )) || (
                            <tr>
                              <td className="px-3 py-2 font-mono text-xs">CNAME</td>
                              <td className="px-3 py-2 font-mono text-xs">{domain}</td>
                              <td className="px-3 py-2 font-mono text-xs">cname.vercel-dns.com</td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                    <div className="mt-3 flex items-center justify-between">
                      <p className="text-xs text-amber-700">{t('dnsPropagation')}</p>
                      <Button variant="outline" size="sm" onClick={checkDns} disabled={isChecking}>
                        {isChecking ? t('checkingDns') : t('checkDns')}
                      </Button>
                    </div>
                  </div>
                )}

                {domainStatus?.verified && (
                  <p className="text-sm text-[hsl(var(--success))]">
                    {t('verifiedMessage', { domain })}
                  </p>
                )}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{t('noDomain')}</p>
            )}
          </div>
        </div>
      </div>
    </AdminLayout>
  );
}
