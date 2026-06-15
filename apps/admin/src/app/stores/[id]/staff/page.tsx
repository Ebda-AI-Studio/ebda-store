'use client';

import { useParams } from 'next/navigation';
import { useState, useEffect, useCallback } from 'react';
import { Button, Badge, Modal, ModalBody, ModalFooter, Input, Label, useToast } from '@force/ui';
import { AdminLayout } from '../../../../components/AdminLayout';
import { apiGet, apiPost, apiDelete } from '../../../../lib/api';
import { useAuth } from '../../../../lib/auth';
import { useRouter } from 'next/navigation';

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

export default function StoreStaffPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const router = useRouter();
  const { user } = useAuth();
  const { success: toastSuccess, error: toastError } = useToast();

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
    password: '',
  });

  const [removeTarget, setRemoveTarget] = useState<StaffMember | null>(null);
  const [removing, setRemoving] = useState(false);

  function resetInviteForm() {
    setInviteForm({ email: '', firstName: '', lastName: '', password: '' });
    setInviteError(null);
  }

  function formatDate(date: string | null) {
    if (!date) return 'Never';
    return new Date(date).toLocaleDateString('en-US', {
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
        setError(apiError.message || 'Failed to load staff.');
      }
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setIsLoading(false);
    }
  }, [storeId]);

  useEffect(() => {
    if (storeId) fetchStaff();
  }, [fetchStaff, storeId]);

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    setInviteError(null);
    setInviting(true);
    try {
      const { error: apiError } = await apiPost(`/api/v1/stores/${storeId}/staff`, inviteForm);
      if (apiError) {
        setInviteError(apiError.message || 'Failed to add staff member.');
        return;
      }
      toastSuccess('Staff member added', `${inviteForm.firstName} can now log in.`);
      setInviteOpen(false);
      resetInviteForm();
      await fetchStaff();
    } catch {
      setInviteError('Network error. Please try again.');
    } finally {
      setInviting(false);
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
        toastError('Failed to remove staff member', apiError.message);
        return;
      }
      toastSuccess('Staff member removed', `${removeTarget.firstName} no longer has access.`);
      setRemoveTarget(null);
      await fetchStaff();
    } catch {
      toastError('Error', 'Network error. Please try again.');
    } finally {
      setRemoving(false);
    }
  }

  return (
    <AdminLayout
      title="Staff Members"
      subtitle="Manage who has access to this store. Staff can manage orders, products, and inventory."
      actions={
        <Button size="sm" onClick={() => setInviteOpen(true)}>
          <svg className="me-2 h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Add Staff Member
        </Button>
      }
    >
      {error && !isLoading && (
        <div className="mb-6 rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="rounded-xl border bg-card shadow-sm overflow-hidden overflow-x-auto">
        <table className="w-full" aria-label="Staff members">
          <thead className="bg-muted border-b">
            <tr>
              <th className="px-6 py-3 text-start text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Member
              </th>
              <th className="px-6 py-3 text-start text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Status
              </th>
              <th className="px-6 py-3 text-start text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Added
              </th>
              <th className="px-6 py-3 text-start text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Last login
              </th>
              <th className="px-6 py-3 text-end text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {isLoading ? (
              Array.from({ length: 3 }).map((_, i) => (
                <tr key={i}>
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-3">
                      <div className="h-10 w-10 bg-muted rounded-full animate-pulse" />
                      <div>
                        <div className="h-4 w-32 bg-muted rounded animate-pulse" />
                        <div className="h-3 w-40 bg-muted rounded animate-pulse mt-1" />
                      </div>
                    </div>
                  </td>
                  {[1, 2, 3, 4].map(j => (
                    <td key={j} className="px-6 py-4">
                      <div className="h-4 w-20 bg-muted rounded animate-pulse" />
                    </td>
                  ))}
                </tr>
              ))
            ) : staff.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-6 py-12 text-center">
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
                    <p className="mt-4 text-muted-foreground">No staff members yet.</p>
                    <p className="text-sm text-muted-foreground mt-1">
                      Add team members so they can manage orders and products.
                    </p>
                  </div>
                </td>
              </tr>
            ) : (
              staff.map(member => (
                <tr key={member.membershipId} className="hover:bg-muted">
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-3">
                      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-amber-500/10 text-amber-700 dark:text-amber-400">
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
                  </td>
                  <td className="px-6 py-4">
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
                  </td>
                  <td className="px-6 py-4 text-sm text-muted-foreground">
                    {formatDate(member.createdAt)}
                  </td>
                  <td className="px-6 py-4 text-sm text-muted-foreground">
                    {formatDate(member.lastLoginAt)}
                  </td>
                  <td className="px-6 py-4 text-end">
                    <Button variant="outline" size="sm" onClick={() => setRemoveTarget(member)}>
                      Remove
                    </Button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Add staff modal */}
      <Modal
        isOpen={inviteOpen}
        onClose={() => {
          setInviteOpen(false);
          resetInviteForm();
        }}
        title="Add Staff Member"
        size="md"
      >
        <form onSubmit={handleInvite}>
          <ModalBody className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Staff members can manage orders, products, and inventory but cannot change store
              settings, payment configuration, or financial records.
            </p>
            <div>
              <Label htmlFor="staff-email">Email</Label>
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
                <Label htmlFor="staff-first">First name</Label>
                <Input
                  id="staff-first"
                  required
                  value={inviteForm.firstName}
                  onChange={e => setInviteForm({ ...inviteForm, firstName: e.target.value })}
                />
              </div>
              <div>
                <Label htmlFor="staff-last">Last name</Label>
                <Input
                  id="staff-last"
                  required
                  value={inviteForm.lastName}
                  onChange={e => setInviteForm({ ...inviteForm, lastName: e.target.value })}
                />
              </div>
            </div>
            <div>
              <Label htmlFor="staff-password">Initial password</Label>
              <Input
                id="staff-password"
                type="password"
                required
                minLength={8}
                autoComplete="new-password"
                value={inviteForm.password}
                onChange={e => setInviteForm({ ...inviteForm, password: e.target.value })}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Share this with the staff member. They can change it after first login.
              </p>
            </div>
            {inviteError && (
              <p className="text-sm text-destructive" role="alert">
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
              Cancel
            </Button>
            <Button type="submit" disabled={inviting} isLoading={inviting}>
              {inviting ? 'Adding…' : 'Add Staff Member'}
            </Button>
          </ModalFooter>
        </form>
      </Modal>

      {/* Remove confirmation modal */}
      <Modal
        isOpen={!!removeTarget}
        onClose={() => setRemoveTarget(null)}
        title="Remove Staff Member"
        size="sm"
      >
        <p className="text-sm text-muted-foreground">
          Remove{' '}
          <strong>
            {removeTarget?.firstName} {removeTarget?.lastName}
          </strong>{' '}
          ({removeTarget?.email}) from this store? They will lose access immediately.
        </p>
        <div className="mt-6 flex justify-end gap-3">
          <Button variant="outline" onClick={() => setRemoveTarget(null)} disabled={removing}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleRemove}
            disabled={removing}
            isLoading={removing}
          >
            {removing ? 'Removing…' : 'Remove'}
          </Button>
        </div>
      </Modal>
    </AdminLayout>
  );
}
