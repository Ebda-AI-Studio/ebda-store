'use client';

import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Input, Label } from '@force/ui';
import { apiGet, apiPut } from '../../../../lib/api';
import { useT } from '@/i18n/useT';

interface DomainStatus {
  domain: string;
  verified: boolean;
  misconfigured: boolean;
  dnsRecords: Array<{ type: string; name: string; value: string }>;
}

interface DomainSectionProps {
  storeId: string;
  domain: string | null;
  onDomainChange: () => void;
}

export function DomainSection({ storeId, domain, onDomainChange }: DomainSectionProps) {
  const t = useT('stores.dashboard.domain');
  const [isEditing, setIsEditing] = useState(false);
  const [newDomain, setNewDomain] = useState(domain || '');
  const [isSaving, setIsSaving] = useState(false);
  const [isChecking, setIsChecking] = useState(false);
  const [domainStatus, setDomainStatus] = useState<DomainStatus | null>(null);
  const [domainError, setDomainError] = useState('');

  const checkDns = useCallback(async () => {
    if (!domain) return;
    setIsChecking(true);
    try {
      const { data } = await apiGet<DomainStatus>(`/api/v1/stores/${storeId}/domain`);
      if (data) {
        setDomainStatus(data);
      }
    } catch {
      // non-critical
    } finally {
      setIsChecking(false);
    }
  }, [domain, storeId]);

  useEffect(() => {
    checkDns();
  }, [checkDns]);

  async function handleSaveDomain() {
    const trimmed = newDomain.trim().toLowerCase();
    if (
      trimmed &&
      !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(trimmed)
    ) {
      setDomainError(t('invalid'));
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
        onDomainChange();
        if (trimmed) {
          // Refresh status after DNS record is registered.
          setTimeout(checkDns, 1000);
        } else {
          setDomainStatus(null);
        }
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
        onDomainChange();
      }
    } catch {
      // non-critical
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="mt-8">
      <div className="rounded-xl border bg-card shadow-sm">
        <div className="flex items-center justify-between border-b p-4">
          <h2 className="font-semibold text-foreground">{t('title')}</h2>
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
                {domain ? t('change') : t('add')}
              </Button>
            )}
            {domain && !isEditing && (
              <Button variant="outline" size="sm" onClick={handleRemoveDomain} disabled={isSaving}>
                {t('remove')}
              </Button>
            )}
          </div>
        </div>
        <div className="p-6">
          {isEditing ? (
            <div className="space-y-4">
              <div>
                <Label htmlFor="domain">{t('label')}</Label>
                <Input
                  id="domain"
                  value={newDomain}
                  onChange={e => {
                    setNewDomain(e.target.value.toLowerCase());
                    setDomainError('');
                  }}
                  placeholder={t('placeholder')}
                  className={`mt-1 ${domainError ? 'border-destructive' : ''}`}
                />
                {domainError && <p className="mt-1 text-sm text-destructive">{domainError}</p>}
                <p className="mt-1 text-xs text-muted-foreground">{t('removeHint')}</p>
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

              {/* DNS Instructions (always visible while unverified) */}
              {!domainStatus?.verified && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
                  <p className="text-sm font-medium text-amber-900">{t('dnsRequired')}</p>
                  <p className="mt-1 text-sm text-amber-800">{t('dnsInstructions')}</p>
                  <div className="mt-3 overflow-hidden rounded-md border border-amber-200 bg-white">
                    <table className="w-full text-sm" aria-label={t('tableLabel')}>
                      <thead>
                        <tr className="border-b bg-amber-50">
                          <th
                            scope="col"
                            className="px-3 py-2 text-start font-medium text-amber-900"
                          >
                            {t('columnType')}
                          </th>
                          <th
                            scope="col"
                            className="px-3 py-2 text-start font-medium text-amber-900"
                          >
                            {t('columnName')}
                          </th>
                          <th
                            scope="col"
                            className="px-3 py-2 text-start font-medium text-amber-900"
                          >
                            {t('columnValue')}
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
            <p className="text-sm text-muted-foreground">{t('empty')}</p>
          )}
        </div>
      </div>
    </div>
  );
}
