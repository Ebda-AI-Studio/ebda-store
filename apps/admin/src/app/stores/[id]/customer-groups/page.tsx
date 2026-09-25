'use client';

/**
 * /stores/[id]/customer-groups — merchant-defined customer segments.
 *
 * Satisfies the "every data has a UI" gate for the `customer_groups` table.
 * Deliberately ungated: groups are the dependency root for promotion/coupon
 * targeting and group-scoped pricing, so a feature gate here would gate those.
 */

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { useT } from '@/i18n/useT';
import { AdminLayout } from '../../../../components/AdminLayout';
import { apiGet, apiPost, apiPut, apiDelete } from '../../../../lib/api';
import { DataTable, type DataTableColumn } from '@/components/mobile/DataTable';

interface CustomerGroup {
  id: string;
  name: string;
  nameAr: string | null;
  isActive: boolean;
  isDefault: boolean;
  customerCount: number;
}

interface FormState {
  name: string;
  nameAr: string;
  isActive: boolean;
  isDefault: boolean;
}

const EMPTY_FORM: FormState = { name: '', nameAr: '', isActive: true, isDefault: false };

export default function CustomerGroupsPage() {
  const params = useParams();
  const storeId = params.id as string;
  const t = useT('customerGroups.page');

  const [groups, setGroups] = useState<CustomerGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<CustomerGroup | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  const fetchGroups = useCallback(async () => {
    try {
      const { data } = await apiGet<{ groups: CustomerGroup[] }>(
        `/api/v1/stores/${storeId}/customer-groups`
      );
      setGroups(data?.groups ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [storeId, t]);

  useEffect(() => {
    void fetchGroups();
  }, [fetchGroups]);

  const openCreate = () => {
    setEditing(null);
    // First group in an empty store becomes the default — a store with no
    // default has nowhere to put new customers.
    setForm({ ...EMPTY_FORM, isDefault: groups.length === 0 });
    setShowModal(true);
  };

  const openEdit = (group: CustomerGroup) => {
    setEditing(group);
    setForm({
      name: group.name,
      nameAr: group.nameAr ?? '',
      isActive: group.isActive,
      isDefault: group.isDefault,
    });
    setShowModal(true);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const body = {
        name: form.name.trim(),
        nameAr: form.nameAr.trim() || null,
        isActive: form.isActive,
        isDefault: form.isDefault,
      };
      if (editing) {
        await apiPut(`/api/v1/stores/${storeId}/customer-groups/${editing.id}`, body);
      } else {
        await apiPost(`/api/v1/stores/${storeId}/customer-groups`, body);
      }
      setShowModal(false);
      await fetchGroups();
    } catch (err) {
      // Surface the API's message — it distinguishes duplicate name (409) from
      // "set another group as default instead" (400).
      setError(err instanceof Error ? err.message : t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (group: CustomerGroup) => {
    if (!window.confirm(t('deleteConfirm', { name: group.name, count: group.customerCount }))) {
      return;
    }
    setError(null);
    try {
      await apiDelete(`/api/v1/stores/${storeId}/customer-groups/${group.id}`);
      await fetchGroups();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('deleteFailed'));
    }
  };

  const columns: DataTableColumn<CustomerGroup>[] = [
    {
      header: t('name'),
      primaryOnMobile: true,
      cell: group => (
        <>
          <span className="font-medium">{group.name}</span>
          {group.nameAr && (
            <span className="ms-2 text-muted-foreground" dir="rtl">
              {group.nameAr}
            </span>
          )}
          {group.isDefault && (
            <span className="ms-2 rounded bg-primary/10 px-1.5 py-0.5 text-xs text-primary">
              {t('defaultBadge')}
            </span>
          )}
        </>
      ),
    },
    {
      header: t('customers'),
      cell: group => <span className="tabular-nums">{group.customerCount}</span>,
    },
    {
      header: t('status'),
      mobileBadge: true,
      cell: group => <>{group.isActive ? t('statusActive') : t('statusInactive')}</>,
    },
    {
      header: t('actions'),
      alignEnd: true,
      mobileActions: true,
      cell: group => (
        <>
          <button
            type="button"
            onClick={() => openEdit(group)}
            className="text-primary hover:underline"
          >
            {t('edit')}
          </button>
          <button
            type="button"
            onClick={() => void remove(group)}
            className="ms-3 text-destructive hover:underline"
          >
            {t('delete')}
          </button>
        </>
      ),
    },
  ];

  return (
    <AdminLayout
      title={t('title')}
      subtitle={t('subtitle')}
      mode="store_admin"
      storeId={storeId}
      actions={
        <button
          type="button"
          onClick={openCreate}
          className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground"
        >
          {t('addNew')}
        </button>
      }
    >
      <div className="mx-auto max-w-4xl px-4 py-6">
        {error && (
          <div
            role="alert"
            className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </div>
        )}

        {loading ? (
          <p className="py-12 text-center text-sm text-muted-foreground">{t('loading')}</p>
        ) : groups.length === 0 ? (
          <div className="rounded-md border border-dashed py-12 text-center">
            <p className="text-sm font-medium">{t('emptyTitle')}</p>
            <p className="mt-1 text-sm text-muted-foreground">{t('emptyBody')}</p>
          </div>
        ) : (
          <DataTable<CustomerGroup> columns={columns} rows={groups} rowKey={group => group.id} />
        )}

        {showModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="w-full max-w-md rounded-lg bg-background p-5 shadow-lg">
              <h2 className="mb-4 text-lg font-semibold">
                {editing ? t('editTitle') : t('createTitle')}
              </h2>

              <label className="mb-3 block">
                <span className="mb-1 block text-sm font-medium">{t('name')}</span>
                <input
                  value={form.name}
                  onChange={e => setForm({ ...form, name: e.target.value })}
                  className="w-full rounded-md border px-3 py-2 text-sm"
                />
              </label>

              <label className="mb-3 block">
                <span className="mb-1 block text-sm font-medium">{t('nameAr')}</span>
                <input
                  value={form.nameAr}
                  onChange={e => setForm({ ...form, nameAr: e.target.value })}
                  dir="rtl"
                  className="w-full rounded-md border px-3 py-2 text-sm"
                />
              </label>

              <label className="mb-2 flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.isActive}
                  onChange={e => setForm({ ...form, isActive: e.target.checked })}
                />
                {t('activeLabel')}
              </label>

              <label className="mb-4 flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.isDefault}
                  disabled={Boolean(editing?.isDefault)}
                  onChange={e => setForm({ ...form, isDefault: e.target.checked })}
                />
                {t('defaultLabel')}
              </label>

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="rounded-md border px-3 py-2 text-sm"
                >
                  {t('cancel')}
                </button>
                <button
                  type="button"
                  onClick={() => void save()}
                  disabled={saving || !form.name.trim()}
                  className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
                >
                  {saving ? t('saving') : t('save')}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
