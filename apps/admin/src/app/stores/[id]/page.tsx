'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Button, Badge, Input, Label } from '@force/ui';
import { AdminLayout } from '../../../components/AdminLayout';
import { formatPrice, formatDate } from '../../../lib/format';
import { apiGet, apiPut, apiPatch } from '../../../lib/api';

interface Store {
  id: string;
  name: string;
  slug: string;
  domain: string | null;
  status: 'active' | 'inactive' | 'suspended';
  plan: 'free' | 'starter' | 'professional' | 'enterprise';
  createdAt: string;
  updatedAt: string;
  owner: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
  };
  _count?: {
    products: number;
    orders: number;
    customers: number;
  };
  stats?: {
    revenue: number;
    ordersThisMonth: number;
  };
}

const statusColors = {
  active: 'default',
  inactive: 'secondary',
  suspended: 'destructive',
} as const;

function DomainSection({
  storeId,
  domain,
  onDomainChange,
}: {
  storeId: string;
  domain: string | null;
  onDomainChange: () => void;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [newDomain, setNewDomain] = useState(domain || '');
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
    if (!domain) return;
    setIsChecking(true);
    try {
      const { data } = await apiGet<{
        domain: string;
        verified: boolean;
        misconfigured: boolean;
        dnsRecords: Array<{ type: string; name: string; value: string }>;
      }>(`/api/v1/stores/${storeId}/domain`);
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
        onDomainChange();
        if (trimmed) {
          // Refresh status
          setTimeout(checkDns, 1000);
        } else {
          setDomainStatus(null);
        }
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
          <h2 className="font-semibold text-foreground">Custom Domain</h2>
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
              <Button variant="outline" size="sm" onClick={handleRemoveDomain} disabled={isSaving}>
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
                  className={`mt-1 ${domainError ? 'border-red-500' : ''}`}
                />
                {domainError && <p className="mt-1 text-sm text-red-500">{domainError}</p>}
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

              {/* DNS Instructions (always visible while unverified) */}
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
                          <th className="px-3 py-2 text-left font-medium text-amber-900">Value</th>
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
                <p className="text-sm text-green-600">
                  Domain is verified and SSL is active. Your store is accessible at https://{domain}
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
  );
}

export default function StoreDetailPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const [store, setStore] = useState<Store | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [editForm, setEditForm] = useState({ name: '', slug: '', plan: '', status: '' });
  const [formErrors, setFormErrors] = useState<{ name?: string; slug?: string }>({});

  const fetchStore = useCallback(async () => {
    if (!storeId) return;
    try {
      const { data } = await apiGet<{ store: Store }>(`/api/v1/stores/${storeId}`);
      if (data?.store) {
        setStore(data.store);
        setEditForm({
          name: data.store.name,
          slug: data.store.slug,
          plan: data.store.plan,
          status: data.store.status,
        });
      }
    } catch (error) {
      console.error('Failed to fetch store:', error);
    } finally {
      setIsLoading(false);
    }
  }, [storeId]);

  useEffect(() => {
    fetchStore();
  }, [fetchStore]);

  function validateForm(): boolean {
    const errors: { name?: string; slug?: string } = {};

    // Validate name
    if (!editForm.name.trim()) {
      errors.name = 'Store name is required';
    } else if (editForm.name.trim().length < 2) {
      errors.name = 'Store name must be at least 2 characters';
    } else if (editForm.name.trim().length > 100) {
      errors.name = 'Store name must be less than 100 characters';
    }

    // Validate slug
    if (!editForm.slug.trim()) {
      errors.slug = 'URL slug is required';
    } else if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(editForm.slug)) {
      errors.slug = 'Slug must be lowercase, alphanumeric, with hyphens only';
    } else if (editForm.slug.length < 3) {
      errors.slug = 'Slug must be at least 3 characters';
    } else if (editForm.slug.length > 50) {
      errors.slug = 'Slug must be less than 50 characters';
    }

    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  }

  async function handleSave() {
    if (!validateForm()) {
      return;
    }

    setIsSaving(true);
    try {
      const { data, error: apiError } = await apiPut<{ store: Store }>(
        `/api/v1/stores/${storeId}`,
        {
          name: editForm.name.trim(),
          slug: editForm.slug.trim().toLowerCase(),
          plan: editForm.plan,
          status: editForm.status,
        }
      );
      if (data?.store) {
        setStore(data.store);
        setIsEditing(false);
        setFormErrors({});
      } else if (apiError) {
        if (apiError.message?.toLowerCase().includes('slug')) {
          setFormErrors({ slug: 'This slug is already in use' });
        }
      }
    } catch (error) {
      console.error('Failed to update store:', error);
    } finally {
      setIsSaving(false);
    }
  }

  async function handleStatusChange(newStatus: string) {
    await apiPatch(`/api/v1/stores/${storeId}/status`, { status: newStatus });
    fetchStore();
  }

  if (isLoading) {
    return (
      <AdminLayout title="Loading..." subtitle="Please wait">
        <div className="animate-pulse space-y-6">
          <div className="h-32 bg-muted rounded-xl" />
          <div className="grid gap-6 sm:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-24 bg-muted rounded-xl" />
            ))}
          </div>
        </div>
      </AdminLayout>
    );
  }

  if (!store) {
    return (
      <AdminLayout title="Store Not Found" subtitle="The requested store could not be found">
        <div className="text-center py-12">
          <Link href="/stores" className="text-primary hover:underline">
            Back to Stores
          </Link>
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout
      title={store.name}
      subtitle={store.domain || `force-web-sigma.vercel.app/${store.slug}`}
      actions={
        <div className="flex gap-2">
          <a
            href={
              store.domain
                ? `https://${store.domain}`
                : `${process.env.NEXT_PUBLIC_WEB_URL || 'https://force-web-sigma.vercel.app'}/${store.slug}`
            }
            target="_blank"
            rel="noopener noreferrer"
          >
            <Button variant="outline" size="sm">
              <svg className="mr-2 h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                />
              </svg>
              Visit Store
            </Button>
          </a>
          {!isEditing && (
            <Button size="sm" onClick={() => setIsEditing(true)}>
              Edit Store
            </Button>
          )}
        </div>
      }
    >
      {/* Store Stats */}
      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border bg-white p-6 shadow-sm">
          <p className="text-sm font-medium text-gray-500">Products</p>
          <p className="mt-1 text-2xl font-bold text-foreground">{store._count?.products || 0}</p>
        </div>
        <div className="rounded-xl border bg-white p-6 shadow-sm">
          <p className="text-sm font-medium text-gray-500">Orders</p>
          <p className="mt-1 text-2xl font-bold text-foreground">{store._count?.orders || 0}</p>
        </div>
        <div className="rounded-xl border bg-white p-6 shadow-sm">
          <p className="text-sm font-medium text-gray-500">Customers</p>
          <p className="mt-1 text-2xl font-bold text-foreground">{store._count?.customers || 0}</p>
        </div>
        <div className="rounded-xl border bg-white p-6 shadow-sm">
          <p className="text-sm font-medium text-gray-500">Revenue</p>
          <p className="mt-1 text-2xl font-bold text-primary">
            {formatPrice(store.stats?.revenue || 0)}
          </p>
        </div>
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-3">
        {/* Store Details */}
        <div className="lg:col-span-2 rounded-xl border bg-card shadow-sm">
          <div className="flex items-center justify-between border-b p-4">
            <h2 className="font-semibold text-foreground">Store Details</h2>
            {isEditing && (
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setIsEditing(false);
                    setFormErrors({});
                    if (store) {
                      setEditForm({
                        name: store.name,
                        slug: store.slug,
                        plan: store.plan,
                        status: store.status,
                      });
                    }
                  }}
                >
                  Cancel
                </Button>
                <Button size="sm" onClick={handleSave} disabled={isSaving}>
                  {isSaving ? 'Saving...' : 'Save Changes'}
                </Button>
              </div>
            )}
          </div>
          <div className="p-6 space-y-4">
            {isEditing ? (
              <>
                <div>
                  <Label htmlFor="name">Store Name</Label>
                  <Input
                    id="name"
                    value={editForm.name}
                    onChange={e => {
                      setEditForm(prev => ({ ...prev, name: e.target.value }));
                      if (formErrors.name) setFormErrors(prev => ({ ...prev, name: undefined }));
                    }}
                    className={`mt-1 ${formErrors.name ? 'border-red-500 focus:border-red-500 focus:ring-red-500' : ''}`}
                  />
                  {formErrors.name && (
                    <p className="mt-1 text-sm text-red-500">{formErrors.name}</p>
                  )}
                </div>
                <div>
                  <Label htmlFor="slug">URL Slug</Label>
                  <Input
                    id="slug"
                    value={editForm.slug}
                    onChange={e => {
                      const value = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '');
                      setEditForm(prev => ({ ...prev, slug: value }));
                      if (formErrors.slug) setFormErrors(prev => ({ ...prev, slug: undefined }));
                    }}
                    className={`mt-1 ${formErrors.slug ? 'border-red-500 focus:border-red-500 focus:ring-red-500' : ''}`}
                    placeholder="my-store-name"
                  />
                  {formErrors.slug && (
                    <p className="mt-1 text-sm text-red-500">{formErrors.slug}</p>
                  )}
                  <p className="mt-1 text-xs text-muted-foreground">
                    Your store will be at: {editForm.slug || 'your-slug'}.forcemediakw.com
                  </p>
                </div>
                <div>
                  <Label htmlFor="plan">Plan</Label>
                  <select
                    id="plan"
                    value={editForm.plan}
                    onChange={e => setEditForm(prev => ({ ...prev, plan: e.target.value }))}
                    className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                  >
                    <option value="free">Free</option>
                    <option value="starter">Starter</option>
                    <option value="professional">Professional</option>
                    <option value="enterprise">Enterprise</option>
                  </select>
                </div>
                <div>
                  <Label htmlFor="status">Status</Label>
                  <select
                    id="status"
                    value={editForm.status}
                    onChange={e => setEditForm(prev => ({ ...prev, status: e.target.value }))}
                    className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                  >
                    <option value="active">Active</option>
                    <option value="inactive">Inactive</option>
                    <option value="suspended">Suspended</option>
                  </select>
                </div>
              </>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <p className="text-sm text-muted-foreground">Store Name</p>
                  <p className="font-medium text-foreground">{store.name}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">URL</p>
                  <p className="font-medium text-foreground">
                    {store.domain || `${store.slug}.forcemediakw.com`}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Status</p>
                  <Badge variant={statusColors[store.status]} className="mt-1">
                    {store.status}
                  </Badge>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Plan</p>
                  <p className="font-medium text-foreground capitalize">{store.plan}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Created</p>
                  <p className="font-medium text-foreground">{formatDate(store.createdAt)}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Last Updated</p>
                  <p className="font-medium text-foreground">{formatDate(store.updatedAt)}</p>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Owner Info */}
        <div className="rounded-xl border bg-card shadow-sm">
          <div className="border-b p-4">
            <h2 className="font-semibold text-foreground">Store Owner</h2>
          </div>
          <div className="p-6">
            <div className="flex items-center gap-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
                <span className="text-lg font-bold">
                  {store.owner.firstName[0]}
                  {store.owner.lastName[0]}
                </span>
              </div>
              <div>
                <p className="font-medium text-foreground">
                  {store.owner.firstName} {store.owner.lastName}
                </p>
                <p className="text-sm text-muted-foreground">{store.owner.email}</p>
              </div>
            </div>
            <div className="mt-6 space-y-2">
              <Link href={`/users/${store.owner.id}`}>
                <Button variant="outline" size="sm" className="w-full">
                  View Profile
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </div>

      {/* Domain Management */}
      <DomainSection storeId={store.id} domain={store.domain} onDomainChange={fetchStore} />

      {/* Quick Actions */}
      <div className="mt-8">
        <h2 className="mb-4 font-semibold text-foreground">Quick Actions</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {store.status === 'active' ? (
            <button
              onClick={() => handleStatusChange('suspended')}
              className="flex items-center gap-3 rounded-xl border bg-card p-4 shadow-sm transition hover:border-red-300 hover:shadow-md text-left"
            >
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-red-100">
                <svg
                  className="h-5 w-5 text-red-600"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"
                  />
                </svg>
              </div>
              <div>
                <p className="font-medium text-foreground">Suspend Store</p>
                <p className="text-xs text-muted-foreground">Temporarily disable access</p>
              </div>
            </button>
          ) : (
            <button
              onClick={() => handleStatusChange('active')}
              className="flex items-center gap-3 rounded-xl border bg-card p-4 shadow-sm transition hover:border-green-300 hover:shadow-md text-left"
            >
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-green-100">
                <svg
                  className="h-5 w-5 text-green-600"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
              </div>
              <div>
                <p className="font-medium text-foreground">Activate Store</p>
                <p className="text-xs text-muted-foreground">Enable store access</p>
              </div>
            </button>
          )}

          <Link
            href={`/stores/${store.id}/products`}
            className="flex items-center gap-3 rounded-xl border bg-card p-4 shadow-sm transition hover:border-primary hover:shadow-md"
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-100">
              <svg
                className="h-5 w-5 text-blue-600"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
                />
              </svg>
            </div>
            <div>
              <p className="font-medium text-foreground">View Products</p>
              <p className="text-xs text-muted-foreground">
                {store._count?.products || 0} products
              </p>
            </div>
          </Link>

          <Link
            href={`/stores/${store.id}/orders`}
            className="flex items-center gap-3 rounded-xl border bg-card p-4 shadow-sm transition hover:border-primary hover:shadow-md"
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-purple-100">
              <svg
                className="h-5 w-5 text-purple-600"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
                />
              </svg>
            </div>
            <div>
              <p className="font-medium text-foreground">View Orders</p>
              <p className="text-xs text-muted-foreground">{store._count?.orders || 0} orders</p>
            </div>
          </Link>

          <Link
            href={`/stores/${store.id}/analytics`}
            className="flex items-center gap-3 rounded-xl border bg-card p-4 shadow-sm transition hover:border-primary hover:shadow-md"
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-green-100">
              <svg
                className="h-5 w-5 text-green-600"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
                />
              </svg>
            </div>
            <div>
              <p className="font-medium text-foreground">Analytics</p>
              <p className="text-xs text-muted-foreground">View store metrics</p>
            </div>
          </Link>
        </div>
      </div>

      {/* Settings - single link to settings hub */}
      <div className="mt-8">
        <Link
          href={`/stores/${store.id}/settings`}
          className="flex items-center justify-between rounded-xl border bg-card p-5 shadow-sm transition hover:border-primary hover:shadow-md group"
        >
          <div className="flex items-center gap-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gray-100 transition-transform group-hover:scale-110">
              <svg
                className="h-6 w-6 text-gray-600"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
                />
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                />
              </svg>
            </div>
            <div>
              <p className="font-semibold text-foreground group-hover:text-primary transition-colors">
                Settings & Configuration
              </p>
              <p className="text-sm text-muted-foreground">
                Branding, SEO, shipping, tax, payments, PWA, and more
              </p>
            </div>
          </div>
          <svg
            className="h-5 w-5 text-gray-400 group-hover:text-primary transition-colors"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </Link>
      </div>
    </AdminLayout>
  );
}
