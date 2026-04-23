'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { AdminLayout } from '../../../components/AdminLayout';
import { apiGet, apiPut } from '../../../lib/api';

interface UserDetail {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: 'super_admin' | 'store_admin' | 'customer';
  status: 'active' | 'inactive' | 'suspended';
  isActive: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  stores?: { id: string; name: string; slug: string }[];
}

const ROLE_LABELS: Record<string, string> = {
  super_admin: 'Super Admin',
  store_admin: 'Store Admin',
  customer: 'Customer',
};

const STATUS_STYLES: Record<string, { bg: string; text: string; dot: string }> = {
  active: { bg: 'bg-emerald-50', text: 'text-emerald-700', dot: 'bg-emerald-500' },
  inactive: { bg: 'bg-muted', text: 'text-muted-foreground', dot: 'bg-muted-foreground' },
  suspended: { bg: 'bg-destructive/5', text: 'text-destructive', dot: 'bg-destructive' },
};

function formatDate(dateString: string | null) {
  if (!dateString) return 'Never';
  return new Date(dateString).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function UserDetailPage() {
  const params = useParams();
  const userId = params?.id as string;

  const [user, setUser] = useState<UserDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  // Edit form state
  const [editRole, setEditRole] = useState<string>('customer');
  const [editStatus, setEditStatus] = useState<string>('active');

  const fetchUser = useCallback(async () => {
    if (!userId) return;
    setIsLoading(true);
    setError(null);
    try {
      const { data, error: apiError } = await apiGet<{ user?: UserDetail } & UserDetail>(
        `/api/v1/admin/users/${userId}`
      );
      if (data) {
        const u = (data.user || data) as UserDetail;
        setUser(u);
        setEditRole(u.role);
        setEditStatus(u.status || (u.isActive ? 'active' : 'inactive'));
      } else if (apiError) {
        setError(apiError.message || 'Failed to fetch user');
      }
    } catch {
      setError('Unable to connect to the server. Please check your connection and try again.');
    } finally {
      setIsLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    fetchUser();
  }, [fetchUser]);

  const handleSave = async () => {
    if (!user) return;
    setIsSaving(true);
    setSaveMessage(null);
    try {
      const { data, error: apiError } = await apiPut<{ user?: UserDetail } & UserDetail>(
        `/api/v1/admin/users/${userId}`,
        {
          role: editRole,
          status: editStatus,
          isActive: editStatus === 'active',
        }
      );
      if (data) {
        const u = (data.user || data) as UserDetail;
        setUser(u);
        setEditRole(u.role);
        setEditStatus(u.status || (u.isActive ? 'active' : 'inactive'));
        setSaveMessage({ type: 'success', text: 'User updated successfully' });
      } else if (apiError) {
        setSaveMessage({
          type: 'error',
          text: apiError.message || 'Failed to update user',
        });
      }
    } catch {
      setSaveMessage({ type: 'error', text: 'Unable to connect to the server' });
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <AdminLayout title="Loading..." subtitle="Please wait">
        <div className="animate-pulse space-y-6">
          <div className="h-40 bg-muted rounded-xl" />
          <div className="h-64 bg-muted rounded-xl" />
        </div>
      </AdminLayout>
    );
  }

  if (error || !user) {
    return (
      <AdminLayout title="User Not Found" subtitle="The requested user could not be found">
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-6 text-center">
          <p className="text-destructive">{error || 'User not found'}</p>
          <Link href="/users" className="mt-4 inline-block text-primary hover:underline">
            Back to Users
          </Link>
        </div>
      </AdminLayout>
    );
  }

  const statusStyle =
    STATUS_STYLES[user.status || (user.isActive ? 'active' : 'inactive')] ?? STATUS_STYLES.inactive;
  const hasChanges =
    editRole !== user.role ||
    editStatus !== (user.status || (user.isActive ? 'active' : 'inactive'));

  return (
    <AdminLayout
      title={`${user.firstName} ${user.lastName}`}
      subtitle={user.email}
      actions={
        <Link href="/users">
          <button className="px-4 py-2 text-sm border border-border rounded-lg hover:bg-muted font-medium">
            Back to Users
          </button>
        </Link>
      }
    >
      <div className="grid gap-6 lg:grid-cols-3">
        {/* User Profile Card */}
        <div className="lg:col-span-1">
          <div className="rounded-xl border bg-card shadow-sm">
            <div className="border-b p-4">
              <h2 className="font-semibold text-foreground">Profile</h2>
            </div>
            <div className="p-6 text-center">
              <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-primary/10 text-primary">
                <span className="text-2xl font-bold">
                  {user.firstName[0]}
                  {user.lastName[0]}
                </span>
              </div>
              <h3 className="mt-4 text-lg font-semibold text-foreground">
                {user.firstName} {user.lastName}
              </h3>
              <p className="text-sm text-muted-foreground">{user.email}</p>

              <div className="mt-4 flex justify-center">
                <span
                  className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium ${statusStyle.bg} ${statusStyle.text}`}
                >
                  <span className={`h-1.5 w-1.5 rounded-full ${statusStyle.dot}`} />
                  {user.status || (user.isActive ? 'Active' : 'Inactive')}
                </span>
              </div>

              <div className="mt-6 space-y-3 text-left">
                <div>
                  <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Role
                  </p>
                  <p className="mt-1 font-medium text-foreground">
                    {ROLE_LABELS[user.role] || user.role}
                  </p>
                </div>
                <div>
                  <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Member Since
                  </p>
                  <p className="mt-1 text-sm text-foreground">{formatDate(user.createdAt)}</p>
                </div>
                <div>
                  <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Last Login
                  </p>
                  <p className="mt-1 text-sm text-foreground">{formatDate(user.lastLoginAt)}</p>
                </div>
              </div>
            </div>
          </div>

          {/* Stores */}
          {user.stores && user.stores.length > 0 && (
            <div className="mt-6 rounded-xl border bg-card shadow-sm">
              <div className="border-b p-4">
                <h2 className="font-semibold text-foreground">Stores ({user.stores.length})</h2>
              </div>
              <div className="divide-y">
                {user.stores.map(store => (
                  <div key={store.id} className="flex items-center justify-between p-4">
                    <div>
                      <p className="font-medium text-foreground">{store.name}</p>
                      <p className="text-xs text-muted-foreground">{store.slug}</p>
                    </div>
                    <Link
                      href={`/stores/${store.id}`}
                      className="text-sm text-primary hover:underline"
                    >
                      View
                    </Link>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Edit Form */}
        <div className="lg:col-span-2">
          <div className="rounded-xl border bg-card shadow-sm">
            <div className="border-b p-4">
              <h2 className="font-semibold text-foreground">Edit User</h2>
            </div>
            <div className="p-6 space-y-6">
              {/* Read-only info */}
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="block text-sm font-medium text-foreground mb-1">
                    First Name
                  </label>
                  <input
                    type="text"
                    value={user.firstName}
                    disabled
                    className="w-full rounded-lg border border-border bg-muted px-4 py-2 text-sm text-muted-foreground cursor-not-allowed"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-foreground mb-1">
                    Last Name
                  </label>
                  <input
                    type="text"
                    value={user.lastName}
                    disabled
                    className="w-full rounded-lg border border-border bg-muted px-4 py-2 text-sm text-muted-foreground cursor-not-allowed"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-foreground mb-1">
                  Email Address
                </label>
                <input
                  type="email"
                  value={user.email}
                  disabled
                  className="w-full rounded-lg border border-border bg-muted px-4 py-2 text-sm text-muted-foreground cursor-not-allowed"
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  Email cannot be changed from admin panel
                </p>
              </div>

              {/* Editable fields */}
              <div>
                <label className="block text-sm font-medium text-foreground mb-1">Role</label>
                <select
                  value={editRole}
                  onChange={e => setEditRole(e.target.value)}
                  className="w-full rounded-lg border border-border px-4 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  <option value="customer">Customer</option>
                  <option value="store_admin">Store Admin</option>
                  <option value="super_admin">Super Admin</option>
                </select>
                <p className="mt-1 text-xs text-muted-foreground">
                  Changing to super_admin grants full platform access.
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-foreground mb-1">
                  Account Status
                </label>
                <select
                  value={editStatus}
                  onChange={e => setEditStatus(e.target.value)}
                  className="w-full rounded-lg border border-border px-4 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  <option value="active">Active — User can log in and use the platform</option>
                  <option value="inactive">Inactive — Account disabled, cannot log in</option>
                  <option value="suspended">
                    Suspended — Account suspended for policy violation
                  </option>
                </select>
              </div>

              {/* Status toggle as toggle switch for quick active/inactive */}
              <div className="rounded-xl border border-border bg-muted p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-medium text-foreground">Active Status</p>
                    <p className="text-sm text-muted-foreground">
                      Toggle to quickly enable or disable this account
                    </p>
                  </div>
                  <label className="relative inline-flex cursor-pointer items-center">
                    <input
                      type="checkbox"
                      checked={editStatus === 'active'}
                      onChange={e => setEditStatus(e.target.checked ? 'active' : 'inactive')}
                      className="sr-only peer"
                    />
                    <div className="peer h-6 w-11 rounded-full bg-muted after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:border after:border-border after:bg-card after:transition-all after:content-[''] peer-checked:bg-primary peer-checked:after:translate-x-full peer-checked:after:border-white peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-primary/20" />
                  </label>
                </div>
              </div>

              {/* Save message */}
              {saveMessage && (
                <div
                  className={`rounded-lg p-4 text-sm ${
                    saveMessage.type === 'success'
                      ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300'
                      : 'bg-destructive/5 text-destructive dark:bg-destructive/30/20 dark:text-destructive'
                  }`}
                >
                  {saveMessage.text}
                </div>
              )}

              <div className="flex items-center justify-between border-t border-border pt-6">
                <p className="text-xs text-muted-foreground">
                  User ID: <span className="font-mono">{user.id}</span>
                </p>
                <button
                  onClick={handleSave}
                  disabled={isSaving || !hasChanges}
                  className="px-6 py-2 bg-primary text-white rounded-lg hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed font-medium text-sm"
                >
                  {isSaving ? 'Saving...' : 'Save Changes'}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </AdminLayout>
  );
}
