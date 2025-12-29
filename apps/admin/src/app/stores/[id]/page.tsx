'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Button, Badge, Input, Label } from '@force/ui';
import { AdminLayout } from '../../../components/AdminLayout';

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

function formatDate(date: string) {
  return new Date(date).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

function formatPrice(cents: number) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(cents / 100);
}

const statusColors = {
  active: 'default',
  inactive: 'secondary',
  suspended: 'destructive',
} as const;

export default function StoreDetailPage() {
  const params = useParams();
  const [store, setStore] = useState<Store | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [editForm, setEditForm] = useState({ name: '', slug: '', plan: '', status: '' });

  const fetchStore = useCallback(async () => {
    try {
      const token = localStorage.getItem('authToken');
      const response = await fetch(`http://localhost:4000/api/v1/admin/stores/${params.id}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (response.ok) {
        const data = await response.json();
        setStore(data.data.store);
        setEditForm({
          name: data.data.store.name,
          slug: data.data.store.slug,
          plan: data.data.store.plan,
          status: data.data.store.status,
        });
      }
    } catch (error) {
      console.error('Failed to fetch store:', error);
    } finally {
      setIsLoading(false);
    }
  }, [params.id]);

  useEffect(() => {
    fetchStore();
  }, [fetchStore]);

  async function handleSave() {
    setIsSaving(true);
    try {
      const token = localStorage.getItem('authToken');
      const response = await fetch(`http://localhost:4000/api/v1/admin/stores/${params.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(editForm),
      });
      if (response.ok) {
        const data = await response.json();
        setStore(data.data.store);
        setIsEditing(false);
      }
    } catch (error) {
      console.error('Failed to update store:', error);
    } finally {
      setIsSaving(false);
    }
  }

  async function handleStatusChange(newStatus: string) {
    const token = localStorage.getItem('authToken');
    await fetch(`http://localhost:4000/api/v1/admin/stores/${params.id}/status`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ status: newStatus }),
    });
    fetchStore();
  }

  if (isLoading) {
    return (
      <AdminLayout title="Loading..." subtitle="Please wait">
        <div className="animate-pulse space-y-6">
          <div className="h-32 bg-gray-200 rounded-xl" />
          <div className="grid gap-6 sm:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-24 bg-gray-200 rounded-xl" />
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
      subtitle={store.domain || `${store.slug}.forcemediakw.com`}
      actions={
        <div className="flex gap-2">
          <a
            href={`https://${store.domain || `${store.slug}.forcemediakw.com`}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            <Button variant="outline" size="sm">
              <svg className="mr-2 h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
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
          <p className="mt-1 text-2xl font-bold text-gray-900">{store._count?.products || 0}</p>
        </div>
        <div className="rounded-xl border bg-white p-6 shadow-sm">
          <p className="text-sm font-medium text-gray-500">Orders</p>
          <p className="mt-1 text-2xl font-bold text-gray-900">{store._count?.orders || 0}</p>
        </div>
        <div className="rounded-xl border bg-white p-6 shadow-sm">
          <p className="text-sm font-medium text-gray-500">Customers</p>
          <p className="mt-1 text-2xl font-bold text-gray-900">{store._count?.customers || 0}</p>
        </div>
        <div className="rounded-xl border bg-white p-6 shadow-sm">
          <p className="text-sm font-medium text-gray-500">Revenue</p>
          <p className="mt-1 text-2xl font-bold text-primary">{formatPrice(store.stats?.revenue || 0)}</p>
        </div>
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-3">
        {/* Store Details */}
        <div className="lg:col-span-2 rounded-xl border bg-white shadow-sm">
          <div className="flex items-center justify-between border-b p-4">
            <h2 className="font-semibold text-gray-900">Store Details</h2>
            {isEditing && (
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => setIsEditing(false)}>
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
                    onChange={(e) => setEditForm(prev => ({ ...prev, name: e.target.value }))}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label htmlFor="slug">URL Slug</Label>
                  <Input
                    id="slug"
                    value={editForm.slug}
                    onChange={(e) => setEditForm(prev => ({ ...prev, slug: e.target.value }))}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label htmlFor="plan">Plan</Label>
                  <select
                    id="plan"
                    value={editForm.plan}
                    onChange={(e) => setEditForm(prev => ({ ...prev, plan: e.target.value }))}
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
                    onChange={(e) => setEditForm(prev => ({ ...prev, status: e.target.value }))}
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
                  <p className="text-sm text-gray-500">Store Name</p>
                  <p className="font-medium text-gray-900">{store.name}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-500">URL</p>
                  <p className="font-medium text-gray-900">{store.domain || `${store.slug}.forcemediakw.com`}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-500">Status</p>
                  <Badge variant={statusColors[store.status]} className="mt-1">
                    {store.status}
                  </Badge>
                </div>
                <div>
                  <p className="text-sm text-gray-500">Plan</p>
                  <p className="font-medium text-gray-900 capitalize">{store.plan}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-500">Created</p>
                  <p className="font-medium text-gray-900">{formatDate(store.createdAt)}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-500">Last Updated</p>
                  <p className="font-medium text-gray-900">{formatDate(store.updatedAt)}</p>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Owner Info */}
        <div className="rounded-xl border bg-white shadow-sm">
          <div className="border-b p-4">
            <h2 className="font-semibold text-gray-900">Store Owner</h2>
          </div>
          <div className="p-6">
            <div className="flex items-center gap-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
                <span className="text-lg font-bold">
                  {store.owner.firstName[0]}{store.owner.lastName[0]}
                </span>
              </div>
              <div>
                <p className="font-medium text-gray-900">
                  {store.owner.firstName} {store.owner.lastName}
                </p>
                <p className="text-sm text-gray-500">{store.owner.email}</p>
              </div>
            </div>
            <div className="mt-6 space-y-2">
              <Link href={`/users/${store.owner.id}`}>
                <Button variant="outline" size="sm" className="w-full">
                  View Profile
                </Button>
              </Link>
              <Button variant="outline" size="sm" className="w-full">
                Transfer Ownership
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Quick Actions */}
      <div className="mt-8">
        <h2 className="mb-4 font-semibold text-gray-900">Quick Actions</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {store.status === 'active' ? (
            <button
              onClick={() => handleStatusChange('suspended')}
              className="flex items-center gap-3 rounded-xl border bg-white p-4 shadow-sm transition hover:border-red-300 hover:shadow-md text-left"
            >
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-red-100">
                <svg className="h-5 w-5 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                </svg>
              </div>
              <div>
                <p className="font-medium text-gray-900">Suspend Store</p>
                <p className="text-xs text-gray-500">Temporarily disable access</p>
              </div>
            </button>
          ) : (
            <button
              onClick={() => handleStatusChange('active')}
              className="flex items-center gap-3 rounded-xl border bg-white p-4 shadow-sm transition hover:border-green-300 hover:shadow-md text-left"
            >
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-green-100">
                <svg className="h-5 w-5 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <div>
                <p className="font-medium text-gray-900">Activate Store</p>
                <p className="text-xs text-gray-500">Enable store access</p>
              </div>
            </button>
          )}

          <Link
            href={`/stores/${store.id}/products`}
            className="flex items-center gap-3 rounded-xl border bg-white p-4 shadow-sm transition hover:border-primary hover:shadow-md"
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-100">
              <svg className="h-5 w-5 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
              </svg>
            </div>
            <div>
              <p className="font-medium text-gray-900">View Products</p>
              <p className="text-xs text-gray-500">{store._count?.products || 0} products</p>
            </div>
          </Link>

          <Link
            href={`/stores/${store.id}/orders`}
            className="flex items-center gap-3 rounded-xl border bg-white p-4 shadow-sm transition hover:border-primary hover:shadow-md"
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-purple-100">
              <svg className="h-5 w-5 text-purple-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
              </svg>
            </div>
            <div>
              <p className="font-medium text-gray-900">View Orders</p>
              <p className="text-xs text-gray-500">{store._count?.orders || 0} orders</p>
            </div>
          </Link>

          <Link
            href={`/stores/${store.id}/analytics`}
            className="flex items-center gap-3 rounded-xl border bg-white p-4 shadow-sm transition hover:border-primary hover:shadow-md"
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-green-100">
              <svg className="h-5 w-5 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
              </svg>
            </div>
            <div>
              <p className="font-medium text-gray-900">Analytics</p>
              <p className="text-xs text-gray-500">View store metrics</p>
            </div>
          </Link>
        </div>
      </div>
    </AdminLayout>
  );
}
