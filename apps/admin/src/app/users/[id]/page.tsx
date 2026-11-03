'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button, useToast } from '@ebda/ui';
import { AdminLayout } from '../../../components/AdminLayout';
import { apiGet, apiPut, apiDelete } from '../../../lib/api';
import { useT } from '@/i18n/useT';
import { LegalAcceptancesPanel } from '../../../components/legal/LegalAcceptancesPanel';
import { uiIntlTag } from '@/lib/format';

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

const STATUS_STYLES: Record<string, { bg: string; text: string; dot: string }> = {
  active: { bg: 'bg-emerald-50', text: 'text-emerald-700', dot: 'bg-emerald-500' },
  inactive: { bg: 'bg-muted', text: 'text-muted-foreground', dot: 'bg-muted-foreground' },
  suspended: { bg: 'bg-destructive/5', text: 'text-destructive-ink', dot: 'bg-destructive' },
};

export default function UserDetailPage() {
  const t = useT('users.detail');
  const tCommon = useT('common');
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
  const [editFirstName, setEditFirstName] = useState<string>('');
  const [editLastName, setEditLastName] = useState<string>('');
  const [editEmail, setEditEmail] = useState<string>('');
  const [editPassword, setEditPassword] = useState<string>('');
  const [confirmPassword, setConfirmPassword] = useState<string>('');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const router = useRouter();
  const { success: toastSuccess, error: toastError } = useToast();

  function formatDate(dateString: string | null) {
    if (!dateString) return t('neverLoggedIn');
    return new Date(dateString).toLocaleDateString(uiIntlTag(), {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

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
        setEditFirstName(u.firstName);
        setEditLastName(u.lastName);
        setEditEmail(u.email);
      } else if (apiError) {
        setError(apiError.message || t('updateFailed'));
      }
    } catch {
      setError(t('updateNetworkError'));
    } finally {
      setIsLoading(false);
    }
  }, [userId, t]);

  useEffect(() => {
    fetchUser();
  }, [fetchUser]);

  const handleSave = async () => {
    if (!user) return;
    // If a new password is being set, require the confirmation match.
    if (editPassword && editPassword !== confirmPassword) {
      setSaveMessage({ type: 'error', text: t('passwordMismatch') });
      return;
    }
    setIsSaving(true);
    setSaveMessage(null);
    try {
      const body: Record<string, unknown> = {
        firstName: editFirstName.trim(),
        lastName: editLastName.trim(),
        email: editEmail.trim().toLowerCase(),
        role: editRole,
        status: editStatus,
        isActive: editStatus === 'active',
      };
      if (editPassword) body.password = editPassword;

      const { data, error: apiError } = await apiPut<{ user?: UserDetail } & UserDetail>(
        `/api/v1/admin/users/${userId}`,
        body
      );
      if (data) {
        const u = (data.user || data) as UserDetail;
        setUser(u);
        setEditRole(u.role);
        setEditStatus(u.status || (u.isActive ? 'active' : 'inactive'));
        setEditFirstName(u.firstName);
        setEditLastName(u.lastName);
        setEditEmail(u.email);
        // Clear the password fields after a successful save so a
        // refresh / second save doesn't accidentally rewrite the
        // hash with the same value or expose the field as
        // pre-filled.
        setEditPassword('');
        setConfirmPassword('');
        setSaveMessage({ type: 'success', text: t('updateSuccess') });
      } else if (apiError) {
        setSaveMessage({
          type: 'error',
          text: apiError.message || t('updateFailed'),
        });
      }
    } catch {
      setSaveMessage({ type: 'error', text: t('updateNetworkError') });
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!user) return;
    setIsDeleting(true);
    try {
      const { error: apiError } = await apiDelete(`/api/v1/admin/users/${userId}`);
      if (apiError) {
        toastError(t('deleteFailed'), apiError.message ?? '');
        setIsDeleting(false);
        return;
      }
      toastSuccess(t('userDeleted'));
      router.push('/users');
    } catch {
      toastError(t('deleteFailed'), t('deleteNetworkError'));
      setIsDeleting(false);
    }
  };

  if (isLoading) {
    return (
      <AdminLayout title={t('loadingTitle')} subtitle={t('loadingSubtitle')}>
        <div className="animate-pulse space-y-6">
          <div className="h-40 bg-muted rounded-xl" />
          <div className="h-64 bg-muted rounded-xl" />
        </div>
      </AdminLayout>
    );
  }

  if (error || !user) {
    return (
      <AdminLayout title={t('notFoundTitle')} subtitle={t('notFoundSubtitle')}>
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-6 text-center">
          <p className="text-destructive-ink">{error || t('notFoundMessage')}</p>
          <Link href="/users" className="mt-4 inline-block text-primary hover:underline">
            {t('backToUsers')}
          </Link>
        </div>
      </AdminLayout>
    );
  }

  const resolvedStatus = user.status || (user.isActive ? 'active' : 'inactive');
  const statusStyle = STATUS_STYLES[resolvedStatus] ?? STATUS_STYLES.inactive;
  const hasChanges =
    editRole !== user.role ||
    editStatus !== resolvedStatus ||
    editFirstName.trim() !== user.firstName ||
    editLastName.trim() !== user.lastName ||
    editEmail.trim().toLowerCase() !== user.email.toLowerCase() ||
    editPassword.length > 0;

  return (
    <AdminLayout
      title={`${user.firstName} ${user.lastName}`}
      subtitle={user.email}
      actions={
        <Link href="/users">
          <Button type="button" variant="outline">
            {t('backToUsers')}
          </Button>
        </Link>
      }
    >
      <div className="grid gap-6 lg:grid-cols-3">
        {/* User Profile Card */}
        <div className="lg:col-span-1">
          <div className="rounded-xl border bg-card shadow-sm">
            <div className="border-b p-4">
              <h2 className="font-semibold text-foreground">{t('profile')}</h2>
            </div>
            <div className="p-6 text-center">
              <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-primary/10 text-primary-ink">
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
                  {t(`statusLabels.${resolvedStatus}`)}
                </span>
              </div>

              <div className="mt-6 space-y-3 text-start">
                <div>
                  <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    {t('role')}
                  </p>
                  <p className="mt-1 font-medium text-foreground">{t(`roleLabels.${user.role}`)}</p>
                </div>
                <div>
                  <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    {t('memberSince')}
                  </p>
                  <p className="mt-1 text-sm text-foreground">{formatDate(user.createdAt)}</p>
                </div>
                <div>
                  <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    {t('lastLogin')}
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
                <h2 className="font-semibold text-foreground">
                  {t('storesCount', { count: user.stores.length })}
                </h2>
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
                      {t('viewStore')}
                    </Link>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="mt-6">
            <LegalAcceptancesPanel userId={userId} />
          </div>
        </div>

        {/* Edit Form */}
        <div className="lg:col-span-2">
          <div className="rounded-xl border bg-card shadow-sm">
            <div className="border-b p-4">
              <h2 className="font-semibold text-foreground">{t('editUser')}</h2>
            </div>
            <div className="p-6 space-y-6">
              {/* Identity — now editable. Super-admin needs to fix
                  typos / change emails / rename users without going
                  to Postgres directly. */}
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="block text-sm font-medium text-foreground mb-1">
                    {t('firstName')}
                  </label>
                  <input
                    type="text"
                    value={editFirstName}
                    onChange={e => setEditFirstName(e.target.value)}
                    className="w-full rounded-lg border border-border bg-background px-4 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-foreground mb-1">
                    {t('lastName')}
                  </label>
                  <input
                    type="text"
                    value={editLastName}
                    onChange={e => setEditLastName(e.target.value)}
                    className="w-full rounded-lg border border-border bg-background px-4 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-foreground mb-1">
                  {t('emailAddress')}
                </label>
                <input
                  type="email"
                  value={editEmail}
                  onChange={e => setEditEmail(e.target.value)}
                  className="w-full rounded-lg border border-border bg-background px-4 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>

              {/* Set new password — admin-side reset path. Empty
                  fields = leave existing password alone. Doesn't
                  surface the existing hash. */}
              <div className="rounded-xl border border-border/60 bg-muted/30 p-4 space-y-3">
                <p className="text-sm font-medium text-foreground">
                  {t('newPasswordSectionTitle')}
                </p>
                <p className="text-xs text-muted-foreground">{t('newPasswordSectionHint')}</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <input
                    type="password"
                    placeholder={t('newPasswordPlaceholder')}
                    autoComplete="new-password"
                    value={editPassword}
                    onChange={e => setEditPassword(e.target.value)}
                    className="w-full rounded-lg border border-border bg-background px-4 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                  <input
                    type="password"
                    placeholder={t('confirmPasswordPlaceholder')}
                    autoComplete="new-password"
                    value={confirmPassword}
                    onChange={e => setConfirmPassword(e.target.value)}
                    className="w-full rounded-lg border border-border bg-background px-4 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>
                {editPassword && editPassword !== confirmPassword && (
                  <p className="text-xs text-destructive-ink">{t('passwordMismatch')}</p>
                )}
              </div>

              {/* Editable fields */}
              <div>
                <label className="block text-sm font-medium text-foreground mb-1">
                  {t('roleLabel')}
                </label>
                <select
                  value={editRole}
                  onChange={e => setEditRole(e.target.value)}
                  className="w-full rounded-lg border border-border px-4 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  <option value="customer">{t('roleOptions.customer')}</option>
                  <option value="store_admin">{t('roleOptions.store_admin')}</option>
                  <option value="super_admin">{t('roleOptions.super_admin')}</option>
                </select>
                <p className="mt-1 text-xs text-muted-foreground">{t('roleHint')}</p>
              </div>

              <div>
                <label className="block text-sm font-medium text-foreground mb-1">
                  {t('accountStatus')}
                </label>
                <select
                  value={editStatus}
                  onChange={e => setEditStatus(e.target.value)}
                  className="w-full rounded-lg border border-border px-4 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  <option value="active">{t('statusActiveOption')}</option>
                  <option value="inactive">{t('statusInactiveOption')}</option>
                  <option value="suspended">{t('statusSuspendedOption')}</option>
                </select>
              </div>

              {/* Status toggle as toggle switch for quick active/inactive */}
              <div className="rounded-xl border border-border bg-muted p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-medium text-foreground">{t('activeStatus')}</p>
                    <p className="text-sm text-muted-foreground">{t('activeStatusHint')}</p>
                  </div>
                  <label className="relative inline-flex cursor-pointer items-center">
                    <input
                      type="checkbox"
                      checked={editStatus === 'active'}
                      onChange={e => setEditStatus(e.target.checked ? 'active' : 'inactive')}
                      className="sr-only peer"
                    />
                    <div className="peer h-6 w-11 rounded-full bg-muted after:absolute after:start-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:border after:border-border after:bg-card after:transition-all after:content-[''] peer-checked:bg-primary peer-checked:after:translate-x-full peer-checked:after:border-white peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-primary/20" />
                  </label>
                </div>
              </div>

              {/* Save message */}
              {saveMessage && (
                <div
                  className={`rounded-lg p-4 text-sm ${
                    saveMessage.type === 'success'
                      ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300'
                      : 'bg-destructive/5 text-destructive-ink dark:bg-destructive/20 dark:text-destructive-ink'
                  }`}
                >
                  {saveMessage.text}
                </div>
              )}

              <div className="flex items-center justify-between gap-3 border-t border-border pt-6">
                <p className="min-w-0 break-all text-xs text-muted-foreground">
                  {t('userIdLabel')}{' '}
                  <span dir="ltr" className="font-mono" style={{ unicodeBidi: 'isolate' }}>
                    {user.id}
                  </span>
                </p>
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={isSaving || !hasChanges}
                  className="px-6 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed font-medium text-sm"
                >
                  {isSaving ? t('saving') : t('save')}
                </button>
              </div>

              {/* Danger zone — hard-delete the user. The API refuses
                  for self-deletes, the last super_admin, and store-
                  admins who still own stores; the toast will surface
                  the reason. */}
              <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-medium text-destructive-ink">{t('dangerZoneTitle')}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t('dangerZoneDescription')}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowDeleteConfirm(true)}
                    className="rounded-lg border border-destructive bg-card px-4 py-2 text-sm font-medium text-destructive-ink hover:bg-destructive hover:text-destructive-foreground"
                  >
                    {t('deleteUserButton')}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {showDeleteConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => !isDeleting && setShowDeleteConfirm(false)}
        >
          <div
            className="w-full max-w-sm rounded-xl bg-card p-6 shadow-xl"
            onClick={e => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold text-foreground">{t('deleteConfirmTitle')}</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {t.rich('deleteConfirmBody', {
                b: chunks => <strong>{chunks}</strong>,
                name: `${user.firstName} ${user.lastName}`,
                email: user.email,
              })}
            </p>
            <div className="mt-6 flex items-center justify-end gap-3">
              <Button
                type="button"
                variant="outline"
                onClick={() => setShowDeleteConfirm(false)}
                disabled={isDeleting}
              >
                {tCommon('cancel')}
              </Button>
              <Button
                type="button"
                variant="destructive"
                onClick={handleDelete}
                disabled={isDeleting}
                isLoading={isDeleting}
              >
                {isDeleting ? tCommon('deleting') : t('deleteUserButton')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </AdminLayout>
  );
}
