'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { Button, Badge, Input, Label } from '@force/ui';
import { AdminLayout } from '../../../../components/AdminLayout';
import { apiGet, apiPut } from '../../../../lib/api';

interface Store {
  id: string;
  name: string;
  domain: string | null;
}

export default function StoreDomainPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const [store, setStore] = useState<Store | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const fetchStore = useCallback(async () => {
    if (!storeId) return;
    const { data } = await apiGet<{ store: Store }>(`/api/v1/stores/${storeId}`);
    if (data?.store) setStore(data.store);
    setIsLoading(false);
  }, [storeId]);

  useEffect(() => {
    fetchStore();
  }, [fetchStore]);

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
      setDomainError('Please enter a valid domain (e.g., shop.example.com)');
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
        await fetchStore();
        if (trimmed) setTimeout(checkDns, 1000);
        else setDomainStatus(null);
      } else {
        setDomainError(apiError.message || 'Failed to update domain');
      }
    } catch {
      setDomainError('Failed to update domain');
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
        await fetchStore();
      }
    } catch {
      // non-critical
    } finally {
      setIsSaving(false);
    }
  }

  if (isLoading) {
    return (
      <AdminLayout
        title="Custom Domain"
        subtitle="Connect a custom domain to your store"
        mode="store_admin"
        storeId={storeId}
      >
        <div className="mx-auto max-w-4xl p-6">
          <div className="h-64 animate-pulse rounded-xl bg-muted" />
        </div>
      </AdminLayout>
    );
  }

  if (!store) {
    return (
      <AdminLayout
        title="Custom Domain"
        subtitle="Connect a custom domain to your store"
        mode="store_admin"
        storeId={storeId}
      >
        <div className="mx-auto max-w-4xl p-6">
          <p className="text-muted-foreground">Store not found.</p>
        </div>
      </AdminLayout>
    );
  }

  const domain = store.domain;

  return (
    <AdminLayout
      title="Custom Domain"
      subtitle="Connect a custom domain to your store"
      mode="store_admin"
      storeId={storeId}
    >
      <div className="mx-auto max-w-4xl p-6">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-foreground">Custom Domain</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Connect a custom domain to your store
          </p>
        </div>

        <div className="rounded-xl border bg-card shadow-sm">
          <div className="flex items-center justify-between border-b p-4">
            <h2 className="font-semibold text-foreground">{store.name} Domain</h2>
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
                  {domain ? 'Change Domain' : 'Add Domain'}
                </Button>
              )}
              {domain && !isEditing && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleRemoveDomain}
                  disabled={isSaving}
                >
                  Remove
                </Button>
              )}
            </div>
          </div>
          <div className="p-6">
            {isEditing ? (
              <div className="space-y-4">
                <div>
                  <Label htmlFor="domain">Domain</Label>
                  <Input
                    id="domain"
                    value={newDomain}
                    onChange={e => {
                      setNewDomain(e.target.value.toLowerCase());
                      setDomainError('');
                    }}
                    placeholder="shop.example.com"
                    className={`mt-1 ${domainError ? 'border-destructive' : ''}`}
                  />
                  {domainError && <p className="mt-1 text-sm text-destructive">{domainError}</p>}
                  <p className="mt-1 text-xs text-muted-foreground">
                    Leave empty and save to remove the custom domain.
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" onClick={handleSaveDomain} disabled={isSaving}>
                    {isSaving ? 'Saving...' : 'Save'}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setIsEditing(false);
                      setDomainError('');
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : domain ? (
              <div className="space-y-4">
                <div className="flex items-center gap-3">
                  <p className="font-medium text-foreground">{domain}</p>
                  <Badge variant={domainStatus?.verified ? 'default' : 'secondary'}>
                    {domainStatus?.verified ? 'Verified' : 'Pending Verification'}
                  </Badge>
                </div>

                {!domainStatus?.verified && (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
                    <p className="text-sm font-medium text-amber-900">DNS Configuration Required</p>
                    <p className="mt-1 text-sm text-amber-800">
                      Add the following DNS record to your domain provider:
                    </p>
                    <div className="mt-3 overflow-hidden rounded-md border border-amber-200 bg-white">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b bg-amber-50">
                            <th className="px-3 py-2 text-left font-medium text-amber-900">Type</th>
                            <th className="px-3 py-2 text-left font-medium text-amber-900">Name</th>
                            <th className="px-3 py-2 text-left font-medium text-amber-900">
                              Value
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
                      <p className="text-xs text-amber-700">
                        DNS changes can take up to 48 hours to propagate.
                      </p>
                      <Button variant="outline" size="sm" onClick={checkDns} disabled={isChecking}>
                        {isChecking ? 'Checking...' : 'Check DNS'}
                      </Button>
                    </div>
                  </div>
                )}

                {domainStatus?.verified && (
                  <p className="text-sm text-[hsl(var(--success))]">
                    Domain is verified and SSL is active. Your store is accessible at https://
                    {domain}
                  </p>
                )}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                No custom domain configured. This store is accessible via its default subdomain.
              </p>
            )}
          </div>
        </div>
      </div>
    </AdminLayout>
  );
}
