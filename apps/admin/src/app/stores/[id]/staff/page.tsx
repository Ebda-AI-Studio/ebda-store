'use client';

import { useParams } from 'next/navigation';
import { useState, useEffect, useCallback } from 'react';
import { Badge, Modal, ModalBody, ModalFooter, Input, Label, useToast } from '@ebda/ui';
import { Button } from '@/components/ui/Button';
import { AdminLayout } from '../../../../components/AdminLayout';
import { apiGet, apiPost, apiDelete } from '../../../../lib/api';
import { useAuth } from '../../../../lib/auth';
import { useRouter } from 'next/navigation';
import { useT } from '@/i18n/useT';
import { useRequireFeature } from '../../../../hooks/useRequireFeature';
import { DataTable, type DataTableColumn } from '@/components/mobile/DataTable';
import { intlLocaleForUi } from '@/lib/format';

interface StaffMember {
  membershipId: string;
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  status: 'active' | 'inactive' | 'suspended';
  lastLoginAt: string | null;
  createdAt: string;
}

interface PendingInvite {
  id: string;
  email: string;
  createdAt: string;
  expiresAt: string;
}

export default function StoreStaffPage() {
  const { gate } = useRequireFeature('staff_accounts');

  const params = useParams();
  const storeId = params?.id as string;
  const router = useRouter();
  const { user } = useAuth();
  const { success: toastSuccess, error: toastError } = useToast();
  const t = useT('staff');

  // Only store owners and super_admin can manage staff
  useEffect(() => {
    if (user && user.role !== 'store_admin' && user.role !== 'super_admin') {
      router.replace(`/stores/${storeId}`);
    }
  }, [user, storeId, router]);

  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteForm, setInviteForm] = useState({
    email: '',
    firstName: '',
    lastName: '',
  });

  const [invites, setInvites] = useState<PendingInvite[]>([]);
  const [revokeTarget, setRevokeTarget] = useState<PendingInvite | null>(null);
  const [revoking, setRevoking] = useState(false);

  const [removeTarget, setRemoveTarget] = useState<StaffMember | null>(null);
  const [removing, setRemoving] = useState(false);

  function resetInviteForm() {
    setInviteForm({ email: '', firstName: '', lastName: '' });
    setInviteError(null);
  }

  function formatDate(date: string | null) {
    if (!date) return t('formatDate.never');
    return new Date(date).toLocaleDateString(intlLocaleForUi(), {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  }

  const fetchStaff = useCallback(async () => {
    try {
      setError(null);
      const { data, error: apiError } = await apiGet<{ staff: StaffMember[] }>(
        `/api/v1/stores/${storeId}/staff`
      );
      if (data) {
        setStaff(data.staff || []);
      } else if (apiError) {
        setError(apiError.message || t('errors.loadFailed'));
      }
      const inv = await apiGet<{ invites: PendingInvite[] }>(
        `/api/v1/stores/${storeId}/staff/invites`
      );
      setInvites(inv.data?.invites ?? []);
    } catch {
      setError(t('errors.networkError'));
    } finally {
      setIsLoading(false);
    }
  }, [storeId, t]);

  useEffect(() => {
    if (storeId) fetchStaff();
  }, [fetchStaff, storeId]);

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    setInviteError(null);
    setInviting(true);
    try {
      const { data: added, error: apiError } = await apiPost<{ status?: string }>(
        `/api/v1/stores/${storeId}/staff`,
        inviteForm
      );
      if (apiError) {
        setInviteError(apiError.message || t('toasts.addFailedDefault'));
        return;
      }
      if (added?.status === 'invitation_sent') {
        toastSuccess(t('invites.sentTitle'), t('invites.sentDesc', { email: inviteForm.email }));
      } else {
        toastSuccess(t('toasts.addedTitle'), t('toasts.addedDesc', { name: inviteForm.firstName }));
      }
      setInviteOpen(false);
      resetInviteForm();
      await fetchStaff();
    } catch {
      setInviteError(t('errors.networkError'));
    } finally {
      setInviting(false);
    }
  }

  async function handleRevoke() {
    if (!revokeTarget) return;
    setRevoking(true);
    try {
      const { error: apiError } = await apiDelete(
        `/api/v1/stores/${storeId}/staff/invites/${revokeTarget.id}`
      );
      if (apiError) {
        toastError(t('invites.revokeFailed'), apiError.message);
        return;
      }
      toastSuccess(
        t('invites.revokedTitle'),
        t('invites.revokedDesc', { email: revokeTarget.email })
      );
      setRevokeTarget(null);
      await fetchStaff();
    } catch {
      toastError(t('toasts.errorTitle'), t('errors.networkError'));
    } finally {
      setRevoking(false);
    }
  }

  async function handleRemove() {
    if (!removeTarget) return;
    setRemoving(true);
    try {
      const { error: apiError } = await apiDelete(
        `/api/v1/stores/${storeId}/staff/${removeTarget.id}`
      );
      if (apiError) {
        toastError(t('toasts.removeFailedTitle'), apiError.message);
        return;
      }
      toastSuccess(
        t('toasts.removedTitle'),
        t('toasts.removedDesc', { name: removeTarget.firstName })
      );
      setRemoveTarget(null);
      await fetchStaff();
    } catch {
      toastError(t('toasts.errorTitle'), t('errors.networkError'));
    } finally {
      setRemoving(false);
    }
  }

  if (gate) return gate;

  const columns: DataTableColumn<StaffMember>[] = [
    {
      header: t('table.colMember'),
      primaryOnMobile: true,
      cell: member => (
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-warning/10 text-warning-ink">
            <span className="text-sm font-bold">
              {member.firstName[0]}
              {member.lastName[0]}
            </span>
          </div>
          <div>
            <p className="font-medium text-foreground">
              {member.firstName} {member.lastName}
            </p>
            <p className="text-sm text-muted-foreground">{member.email}</p>
          </div>
        </div>
      ),
    },
    {
      header: t('table.colStatus'),
      mobileBadge: true,
      cell: member => (
        <Badge
          variant={
            member.status === 'active'
              ? 'default'
              : member.status === 'suspended'
                ? 'destructive'
                : 'secondary'
          }
        >
          {member.status}
        </Badge>
      ),
    },
    {
      header: t('table.colAdded'),
      cell: member => (
        <span className="text-sm text-muted-foreground">{formatDate(member.createdAt)}</span>
      ),
    },
    {
      header: t('table.colLastLogin'),
      cell: member => (
        <span className="text-sm text-muted-foreground">{formatDate(member.lastLoginAt)}</span>
      ),
    },
    {
      header: t('table.colActions'),
      alignEnd: true,
      mobileActions: true,
      cell: member => (
        <Button
          variant="outline"
          size="sm"
          className="max-md:min-h-11 max-md:px-4"
          onClick={() => setRemoveTarget(member)}
        >
          {t('removeModal.removeButton')}
        </Button>
      ),
    },
  ];

  return (
    <AdminLayout
      title={t('page.title')}
      subtitle={t('page.subtitle')}
      actions={
        <Button size="sm" onClick={() => setInviteOpen(true)}>
          <svg className="me-2 h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          {t('page.addButton')}
        </Button>
      }
    >
      {error && !isLoading && (
        <div className="mb-6 rounded-md border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive-ink">
          {error}
        </div>
      )}

      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="rounded-md border border-border bg-card p-4 shadow-sm">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 bg-muted rounded-full animate-pulse" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 w-32 bg-muted rounded-md animate-pulse" />
                  <div className="h-3 w-40 bg-muted rounded-md animate-pulse" />
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <DataTable<StaffMember>
          ariaLabel={t('table.ariaLabel')}
          columns={columns}
          rows={staff}
          rowKey={member => member.membershipId}
          emptyState={
            <div className="rounded-md border bg-card shadow-sm px-6 py-12 text-center">
              <div className="flex flex-col items-center">
                <svg
                  className="h-12 w-12 text-muted-foreground"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1}
                    d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
                  />
                </svg>
                <p className="mt-4 text-muted-foreground">{t('empty.title')}</p>
                <p className="text-sm text-muted-foreground mt-1">{t('empty.description')}</p>
              </div>
            </div>
          }
        />
      )}

      {invites.length > 0 && (
        <section className="mt-8" aria-labelledby="pending-invites-title">
          <h2 id="pending-invites-title" className="text-sm font-semibold text-foreground">
            {t('invites.title')}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{t('invites.description')}</p>
          <ul className="mt-3 divide-y divide-border rounded-md border border-border bg-card">
            {invites.map(inv => (
              <li key={inv.id} className="flex items-center justify-between gap-3 p-4">
                <div className="min-w-0">
                  <p className="truncate font-medium text-foreground" dir="ltr">
                    {inv.email}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t('invites.expires', { date: formatDate(inv.expiresAt) })}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="max-md:min-h-11 max-md:px-4"
                  onClick={() => setRevokeTarget(inv)}
                >
                  {t('invites.revoke')}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Add staff modal */}
      <Modal
        isOpen={inviteOpen}
        onClose={() => {
          setInviteOpen(false);
          resetInviteForm();
        }}
        title={t('addModal.title')}
        size="md"
      >
        <form onSubmit={handleInvite}>
          <ModalBody className="space-y-4">
            <p className="text-sm text-muted-foreground">{t('addModal.description')}</p>
            <div>
              <Label htmlFor="staff-email">{t('addModal.emailLabel')}</Label>
              <Input
                id="staff-email"
                type="email"
                required
                autoComplete="off"
                value={inviteForm.email}
                onChange={e => setInviteForm({ ...inviteForm, email: e.target.value })}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="staff-first">{t('addModal.firstNameLabel')}</Label>
                <Input
                  id="staff-first"
                  required
                  value={inviteForm.firstName}
                  onChange={e => setInviteForm({ ...inviteForm, firstName: e.target.value })}
                />
              </div>
              <div>
                <Label htmlFor="staff-last">{t('addModal.lastNameLabel')}</Label>
                <Input
                  id="staff-last"
                  required
                  value={inviteForm.lastName}
                  onChange={e => setInviteForm({ ...inviteForm, lastName: e.target.value })}
                />
              </div>
            </div>
            {inviteError && (
              <p className="text-sm text-destructive-ink" role="alert">
                {inviteError}
              </p>
            )}
          </ModalBody>
          <ModalFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setInviteOpen(false);
                resetInviteForm();
              }}
              disabled={inviting}
            >
              {t('addModal.cancelButton')}
            </Button>
            <Button type="submit" disabled={inviting} isLoading={inviting}>
              {inviting ? t('addModal.addingButton') : t('addModal.submitButton')}
            </Button>
          </ModalFooter>
        </form>
      </Modal>

      {/* Revoke invitation modal */}
      <Modal
        isOpen={!!revokeTarget}
        onClose={() => setRevokeTarget(null)}
        title={t('invites.revokeTitle')}
        size="sm"
      >
        <p className="text-sm text-muted-foreground">
          {t('invites.revokeBody', { email: revokeTarget?.email ?? '' })}
        </p>
        <div className="mt-6 flex justify-end gap-3">
          <Button variant="outline" onClick={() => setRevokeTarget(null)} disabled={revoking}>
            {t('removeModal.cancelButton')}
          </Button>
          <Button
            variant="destructive"
            onClick={handleRevoke}
            disabled={revoking}
            isLoading={revoking}
          >
            {t('invites.revoke')}
          </Button>
        </div>
      </Modal>

      {/* Remove confirmation modal */}
      <Modal
        isOpen={!!removeTarget}
        onClose={() => setRemoveTarget(null)}
        title={t('removeModal.title')}
        size="sm"
      >
        <p className="text-sm text-muted-foreground">
          {t.rich('removeBody', {
            name: `${removeTarget?.firstName ?? ''} ${removeTarget?.lastName ?? ''}`.trim(),
            email: removeTarget?.email ?? '',
            b: chunks => <strong>{chunks}</strong>,
          })}
        </p>
        <div className="mt-6 flex justify-end gap-3">
          <Button variant="outline" onClick={() => setRemoveTarget(null)} disabled={removing}>
            {t('removeModal.cancelButton')}
          </Button>
          <Button
            variant="destructive"
            onClick={handleRemove}
            disabled={removing}
            isLoading={removing}
          >
            {removing ? t('removeModal.removingButton') : t('removeModal.removeButton')}
          </Button>
        </div>
      </Modal>
    </AdminLayout>
  );
}
