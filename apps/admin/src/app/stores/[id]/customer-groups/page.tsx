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
import { useLocale } from 'next-intl';
import { useT } from '@/i18n/useT';
import { useConfirm } from '@/hooks/useConfirm';
import { AdminLayout } from '../../../../components/AdminLayout';
import { apiGet, apiPost, apiPut, apiDelete } from '../../../../lib/api';
import { pctToBps } from './pct';
import { wholesalePlanName } from '@/lib/plan-labels';
import { DataTable, type DataTableColumn } from '@/components/mobile/DataTable';
import { Button } from '@/components/ui/Button';

interface CustomerGroup {
  id: string;
  name: string;
  nameAr: string | null;
  isActive: boolean;
  isDefault: boolean;
  customerCount: number;
  /** B2B pricing (Task 4/7): wholesale flag, percent-off mode and its basis points (1250 = 12.5%). */
  isWholesale: boolean;
  pricingMode: 'none' | 'percent_off';
  discountBps: number;
}

interface FormState {
  name: string;
  nameAr: string;
  isActive: boolean;
  isDefault: boolean;
  isWholesale: boolean;
  pricingMode: 'none' | 'percent_off';
  /** Percent as typed (e.g. "12.5"); converted to basis points on save. */
  discountPct: string;
}

const EMPTY_FORM: FormState = {
  name: '',
  nameAr: '',
  isActive: true,
  isDefault: false,
  isWholesale: false,
  pricingMode: 'none',
  discountPct: '',
};

export default function CustomerGroupsPage() {
  const params = useParams();
  const storeId = params.id as string;
  const t = useT('customerGroups.page');
  const askConfirm = useConfirm();
  const locale = useLocale() === 'ar' ? 'ar' : 'en';

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
    // QA-107: never pre-ticked. A default group auto-enrols EVERY new customer (maybe at a discount); the merchant opts in.
    setForm({ ...EMPTY_FORM });
    setShowModal(true);
  };

  const openEdit = (group: CustomerGroup) => {
    setEditing(group);
    setForm({
      name: group.name,
      nameAr: group.nameAr ?? '',
      isActive: group.isActive,
      isDefault: group.isDefault,
      isWholesale: group.isWholesale,
      pricingMode: group.pricingMode,
      discountPct: group.discountBps ? String(group.discountBps / 100) : '',
    });
    setShowModal(true);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      let discountBps = 0;
      if (form.pricingMode === 'percent_off') {
        const bps = pctToBps(form.discountPct);
        if (bps === null) {
          setError(t('discountInvalid'));
          setSaving(false);
          return;
        }
        discountBps = bps;
      }
      const body = {
        name: form.name.trim(),
        nameAr: form.nameAr.trim() || null,
        isActive: form.isActive,
        isDefault: form.isDefault,
        isWholesale: form.isWholesale,
        pricingMode: form.pricingMode,
        discountBps,
      };
      const res = editing
        ? await apiPut(`/api/v1/stores/${storeId}/customer-groups/${editing.id}`, body)
        : await apiPost(`/api/v1/stores/${storeId}/customer-groups`, body);
      if (res.error) {
        // FEATURE_DISABLED = turning wholesale pricing ON needs the plan (turning it off never does).
        setError(
          res.error.code === 'FEATURE_DISABLED'
            ? t('planRequired', { plan: wholesalePlanName(locale) })
            : res.error.message
        );
        setSaving(false);
        return;
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
    const ok = await askConfirm({
      object: t('deleteDialog.object', { name: group.name }),
      consequence: t('deleteDialog.consequence', { count: group.customerCount }),
      confirmLabel: t('deleteDialog.confirmLabel'),
    });
    if (!ok) return;
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
            <span className="ms-2 rounded bg-primary/10 px-1.5 py-0.5 text-xs text-primary-ink">
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
            className="ms-3 text-destructive-ink hover:underline"
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
        <Button variant="default" size="md" type="button" onClick={openCreate}>
          {t('addNew')}
        </Button>
      }
    >
      <div className="mx-auto max-w-4xl px-4 py-6">
        {error && (
          <div
            role="alert"
            className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive-ink"
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
          <DataTable<CustomerGroup>
            ariaLabel={t('title')}
            columns={columns}
            rows={groups}
            rowKey={group => group.id}
          />
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

              <fieldset className="mb-3 rounded-md border p-3">
                <legend className="px-1 text-sm font-medium">{t('pricingTitle')}</legend>
                <label className="mb-2 flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={form.isWholesale}
                    onChange={e => setForm({ ...form, isWholesale: e.target.checked })}
                  />
                  {t('wholesaleLabel')}
                </label>
                <p className="mb-2 text-xs text-muted-foreground">{t('wholesaleHint')}</p>
                <label className="mb-2 block text-sm">
                  <span className="mb-1 block font-medium">{t('pricingMode')}</span>
                  <select
                    value={form.pricingMode}
                    onChange={e =>
                      setForm({ ...form, pricingMode: e.target.value as FormState['pricingMode'] })
                    }
                    className="min-h-11 w-full rounded-md border px-3 text-sm"
                  >
                    <option value="none">{t('modeNone')}</option>
                    <option value="percent_off">{t('modePercent')}</option>
                  </select>
                </label>
                {form.pricingMode === 'percent_off' ? (
                  <label className="block text-sm">
                    <span className="mb-1 block font-medium">{t('discountPct')}</span>
                    <input
                      inputMode="decimal"
                      dir="ltr"
                      value={form.discountPct}
                      onChange={e => setForm({ ...form, discountPct: e.target.value })}
                      className="min-h-11 w-full rounded-md border px-3 text-sm"
                    />
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {t('discountHint')}
                    </span>
                  </label>
                ) : null}
              </fieldset>

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
                <Button
                  variant="outline"
                  size="md"
                  type="button"
                  onClick={() => setShowModal(false)}
                >
                  {t('cancel')}
                </Button>
                <Button
                  variant="default"
                  size="md"
                  type="button"
                  onClick={() => void save()}
                  disabled={saving || !form.name.trim()}
                >
                  {saving ? t('saving') : t('save')}
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
