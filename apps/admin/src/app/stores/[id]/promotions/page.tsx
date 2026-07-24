'use client';

/**
 * /stores/[id]/promotions — automatic discounts (no code, unlike coupons).
 *
 * Satisfies the "every data has a UI" gate for the `promotions` table.
 * Mirrors apps/admin/src/app/stores/[id]/customer-groups/page.tsx's
 * list + create/edit modal structure. Targeting fields (customer group,
 * first-order-only, min order/quantity, product/category scope) are the
 * same shape shared with coupons — see promotion.routes.ts's createSchema.
 */

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { useT } from '@/i18n/useT';
import { AdminLayout } from '../../../../components/AdminLayout';
import { apiGet, apiPost, apiPut, apiDelete } from '../../../../lib/api';
import { ScopePicker } from '../_components/ScopePicker';

type PromotionType = 'percentage' | 'fixed';

interface Promotion {
  id: string;
  name: string;
  nameAr: string | null;
  description: string | null;
  descriptionAr: string | null;
  type: PromotionType;
  value: number;
  maxDiscount: number | null;
  priority: number;
  isActive: boolean;
  startsAt: string | null;
  expiresAt: string | null;
  customerGroupId: string | null;
  firstOrderOnly: boolean;
  minOrderAmount: number | null;
  minQuantity: number | null;
  scopeProductIds: string[];
  scopeCategoryIds: string[];
}

interface CustomerGroup {
  id: string;
  name: string;
  nameAr: string | null;
}

interface FormState {
  name: string;
  nameAr: string;
  description: string;
  descriptionAr: string;
  type: PromotionType;
  value: string;
  maxDiscount: string;
  priority: string;
  isActive: boolean;
  startsAt: string;
  expiresAt: string;
  customerGroupId: string;
  firstOrderOnly: boolean;
  minOrderAmount: string;
  minQuantity: string;
  scopeProductIds: string[];
  scopeCategoryIds: string[];
}

const EMPTY_FORM: FormState = {
  name: '',
  nameAr: '',
  description: '',
  descriptionAr: '',
  type: 'percentage',
  value: '',
  maxDiscount: '',
  priority: '0',
  isActive: true,
  startsAt: '',
  expiresAt: '',
  customerGroupId: '',
  firstOrderOnly: false,
  minOrderAmount: '',
  minQuantity: '',
  scopeProductIds: [],
  scopeCategoryIds: [],
};

export default function PromotionsPage() {
  const params = useParams();
  const storeId = params.id as string;
  const t = useT('promotions.page');

  const [promotions, setPromotions] = useState<Promotion[]>([]);
  const [groups, setGroups] = useState<CustomerGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<Promotion | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  const fetchPromotions = useCallback(async () => {
    try {
      const { data } = await apiGet<{ promotions: Promotion[] }>(
        `/api/v1/stores/${storeId}/promotions`
      );
      setPromotions(data?.promotions ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [storeId, t]);

  const fetchGroups = useCallback(async () => {
    const { data } = await apiGet<{ groups: CustomerGroup[] }>(
      `/api/v1/stores/${storeId}/customer-groups`
    );
    setGroups(data?.groups ?? []);
  }, [storeId]);

  useEffect(() => {
    void fetchPromotions();
    void fetchGroups();
  }, [fetchPromotions, fetchGroups]);

  const groupName = (groupId: string | null) => {
    if (!groupId) return null;
    const group = groups.find(g => g.id === groupId);
    return group?.name ?? null;
  };

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setShowModal(true);
  };

  const openEdit = (promo: Promotion) => {
    setEditing(promo);
    setForm({
      name: promo.name,
      nameAr: promo.nameAr ?? '',
      description: promo.description ?? '',
      descriptionAr: promo.descriptionAr ?? '',
      type: promo.type,
      // `fixed` promotions are stored in fils → show as KWD (÷1000) in the
      // form. `percentage` promotions store the raw percent, shown as-is.
      value: String(promo.type === 'fixed' ? promo.value / 1000 : promo.value),
      maxDiscount: promo.maxDiscount != null ? String(promo.maxDiscount / 1000) : '',
      priority: String(promo.priority),
      isActive: promo.isActive,
      startsAt: promo.startsAt ? promo.startsAt.slice(0, 16) : '',
      expiresAt: promo.expiresAt ? promo.expiresAt.slice(0, 16) : '',
      customerGroupId: promo.customerGroupId ?? '',
      firstOrderOnly: promo.firstOrderOnly,
      minOrderAmount: promo.minOrderAmount != null ? String(promo.minOrderAmount / 1000) : '',
      minQuantity: promo.minQuantity != null ? String(promo.minQuantity) : '',
      scopeProductIds: promo.scopeProductIds ?? [],
      scopeCategoryIds: promo.scopeCategoryIds ?? [],
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
        description: form.description.trim() || null,
        descriptionAr: form.descriptionAr.trim() || null,
        type: form.type,
        // `fixed` promotions: the input is in KWD (dinar) → store as fils
        // (×1000). `percentage` promotions: the value is a percent (e.g. 5 =
        // 5%), stored as-is — NOT money.
        value:
          form.type === 'fixed'
            ? Math.round((parseFloat(form.value) || 0) * 1000)
            : parseInt(form.value, 10) || 0,
        maxDiscount: form.maxDiscount ? Math.round(parseFloat(form.maxDiscount) * 1000) : null,
        priority: form.priority ? parseInt(form.priority, 10) : 0,
        isActive: form.isActive,
        startsAt: form.startsAt ? new Date(form.startsAt).toISOString() : null,
        expiresAt: form.expiresAt ? new Date(form.expiresAt).toISOString() : null,
        customerGroupId: form.customerGroupId || null,
        firstOrderOnly: form.firstOrderOnly,
        minOrderAmount: form.minOrderAmount
          ? Math.round(parseFloat(form.minOrderAmount) * 1000)
          : null,
        minQuantity: form.minQuantity ? parseInt(form.minQuantity, 10) : null,
        scopeProductIds: form.scopeProductIds,
        scopeCategoryIds: form.scopeCategoryIds,
      };
      const { error } = editing
        ? await apiPut(`/api/v1/stores/${storeId}/promotions/${editing.id}`, body)
        : await apiPost(`/api/v1/stores/${storeId}/promotions`, body);
      if (error) {
        setError(error.message || t('saveFailed'));
        return;
      }
      setShowModal(false);
      await fetchPromotions();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (promo: Promotion) => {
    if (!window.confirm(t('deleteConfirm', { name: promo.name }))) {
      return;
    }
    setError(null);
    try {
      const { error } = await apiDelete(`/api/v1/stores/${storeId}/promotions/${promo.id}`);
      if (error) {
        setError(error.message || t('deleteFailed'));
        return;
      }
      await fetchPromotions();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('deleteFailed'));
    }
  };

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
      <div className="mx-auto max-w-5xl px-4 py-6">
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
        ) : promotions.length === 0 ? (
          <div className="rounded-md border border-dashed py-12 text-center">
            <p className="text-sm font-medium">{t('emptyTitle')}</p>
            <p className="mt-1 text-sm text-muted-foreground">{t('emptyBody')}</p>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="px-3 py-2 text-start font-medium">{t('name')}</th>
                  <th className="px-3 py-2 text-start font-medium">{t('discount')}</th>
                  <th className="px-3 py-2 text-start font-medium">{t('targeting')}</th>
                  <th className="px-3 py-2 text-start font-medium">{t('priority')}</th>
                  <th className="px-3 py-2 text-start font-medium">{t('status')}</th>
                  <th className="px-3 py-2 text-end font-medium">{t('actions')}</th>
                </tr>
              </thead>
              <tbody>
                {promotions.map(promo => (
                  <tr key={promo.id} className="border-t">
                    <td className="px-3 py-2">
                      <span className="font-medium">{promo.name}</span>
                      {promo.nameAr && (
                        <span className="ms-2 text-muted-foreground" dir="rtl">
                          {promo.nameAr}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 tabular-nums">
                      {promo.type === 'percentage'
                        ? t('valuePercentage', { value: promo.value })
                        : t('valueFixed', { value: promo.value })}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-1">
                        {groupName(promo.customerGroupId) ? (
                          <span className="rounded bg-muted px-1.5 py-0.5 text-xs">
                            {groupName(promo.customerGroupId)}
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">{t('allCustomers')}</span>
                        )}
                        {promo.firstOrderOnly && (
                          <span className="rounded bg-muted px-1.5 py-0.5 text-xs">
                            {t('firstOrderBadge')}
                          </span>
                        )}
                        {(promo.scopeProductIds.length > 0 ||
                          promo.scopeCategoryIds.length > 0) && (
                          <span className="rounded bg-muted px-1.5 py-0.5 text-xs">
                            {t('scopedBadge')}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2 tabular-nums">{promo.priority}</td>
                    <td className="px-3 py-2">
                      {promo.isActive ? t('statusActive') : t('statusInactive')}
                    </td>
                    <td className="px-3 py-2 text-end">
                      <button
                        type="button"
                        onClick={() => openEdit(promo)}
                        className="text-primary hover:underline"
                      >
                        {t('edit')}
                      </button>
                      <button
                        type="button"
                        onClick={() => void remove(promo)}
                        className="ms-3 text-destructive hover:underline"
                      >
                        {t('delete')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {showModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-lg bg-background p-5 shadow-lg">
              <h2 className="mb-4 text-lg font-semibold">
                {editing ? t('editTitle') : t('createTitle')}
              </h2>

              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <label className="block">
                  <span className="mb-1 block text-sm font-medium">{t('name')}</span>
                  <input
                    value={form.name}
                    onChange={e => setForm({ ...form, name: e.target.value })}
                    className="w-full rounded-md border px-3 py-2 text-sm"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-sm font-medium">{t('nameAr')}</span>
                  <input
                    value={form.nameAr}
                    onChange={e => setForm({ ...form, nameAr: e.target.value })}
                    dir="rtl"
                    className="w-full rounded-md border px-3 py-2 text-sm"
                  />
                </label>
              </div>

              <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
                <label className="block">
                  <span className="mb-1 block text-sm font-medium">{t('description')}</span>
                  <input
                    value={form.description}
                    onChange={e => setForm({ ...form, description: e.target.value })}
                    className="w-full rounded-md border px-3 py-2 text-sm"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-sm font-medium">{t('descriptionAr')}</span>
                  <input
                    value={form.descriptionAr}
                    onChange={e => setForm({ ...form, descriptionAr: e.target.value })}
                    dir="rtl"
                    className="w-full rounded-md border px-3 py-2 text-sm"
                  />
                </label>
              </div>

              <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
                <label className="block">
                  <span className="mb-1 block text-sm font-medium">{t('type')}</span>
                  <select
                    value={form.type}
                    onChange={e => setForm({ ...form, type: e.target.value as PromotionType })}
                    className="w-full rounded-md border px-3 py-2 text-sm"
                  >
                    <option value="percentage">{t('typePercentage')}</option>
                    <option value="fixed">{t('typeFixed')}</option>
                  </select>
                </label>
                <label className="block">
                  <span className="mb-1 block text-sm font-medium">
                    {form.type === 'percentage' ? t('valueLabelPercentage') : t('valueLabelFixed')}
                  </span>
                  <input
                    type="number"
                    min={0}
                    max={form.type === 'percentage' ? 100 : undefined}
                    step={form.type === 'percentage' ? 1 : 0.001}
                    value={form.value}
                    onChange={e => setForm({ ...form, value: e.target.value })}
                    className="w-full rounded-md border px-3 py-2 text-sm"
                  />
                </label>
                {form.type === 'percentage' && (
                  <label className="block">
                    <span className="mb-1 block text-sm font-medium">{t('maxDiscount')}</span>
                    <input
                      type="number"
                      min={0}
                      step={0.001}
                      value={form.maxDiscount}
                      onChange={e => setForm({ ...form, maxDiscount: e.target.value })}
                      className="w-full rounded-md border px-3 py-2 text-sm"
                    />
                  </label>
                )}
              </div>

              <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
                <label className="block">
                  <span className="mb-1 block text-sm font-medium">{t('priority')}</span>
                  <input
                    type="number"
                    min={0}
                    max={1000}
                    step={1}
                    value={form.priority}
                    onChange={e => setForm({ ...form, priority: e.target.value })}
                    className="w-full rounded-md border px-3 py-2 text-sm"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-sm font-medium">{t('startsAt')}</span>
                  <input
                    type="datetime-local"
                    value={form.startsAt}
                    onChange={e => setForm({ ...form, startsAt: e.target.value })}
                    className="w-full rounded-md border px-3 py-2 text-sm"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-sm font-medium">{t('expiresAt')}</span>
                  <input
                    type="datetime-local"
                    value={form.expiresAt}
                    onChange={e => setForm({ ...form, expiresAt: e.target.value })}
                    className="w-full rounded-md border px-3 py-2 text-sm"
                  />
                </label>
              </div>

              <label className="mt-3 flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.isActive}
                  onChange={e => setForm({ ...form, isActive: e.target.checked })}
                />
                {t('activeLabel')}
              </label>

              <hr className="my-4 border-border" />
              <h3 className="mb-3 text-sm font-semibold">{t('targetingHeading')}</h3>

              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <label className="block">
                  <span className="mb-1 block text-sm font-medium">{t('customerGroup')}</span>
                  <select
                    value={form.customerGroupId}
                    onChange={e => setForm({ ...form, customerGroupId: e.target.value })}
                    className="w-full rounded-md border px-3 py-2 text-sm"
                  >
                    <option value="">{t('allCustomers')}</option>
                    {groups.map(g => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="mb-1 block text-sm font-medium">{t('minOrderAmount')}</span>
                  <input
                    type="number"
                    min={0}
                    step={0.001}
                    value={form.minOrderAmount}
                    onChange={e => setForm({ ...form, minOrderAmount: e.target.value })}
                    className="w-full rounded-md border px-3 py-2 text-sm"
                  />
                </label>
              </div>

              <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
                <label className="block">
                  <span className="mb-1 block text-sm font-medium">{t('minQuantity')}</span>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={form.minQuantity}
                    onChange={e => setForm({ ...form, minQuantity: e.target.value })}
                    className="w-full rounded-md border px-3 py-2 text-sm"
                  />
                </label>
                <label className="mt-6 flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={form.firstOrderOnly}
                    onChange={e => setForm({ ...form, firstOrderOnly: e.target.checked })}
                  />
                  {t('firstOrderOnlyLabel')}
                </label>
              </div>

              <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
                <ScopePicker
                  storeId={storeId}
                  kind="products"
                  value={form.scopeProductIds}
                  onChange={ids => setForm({ ...form, scopeProductIds: ids })}
                  label={t('scopeProducts')}
                  searchPlaceholder={t('scopeProductsPlaceholder')}
                  emptyHint={t('scopeEmptyHint')}
                  removeLabel={t('scopeRemove')}
                />
                <ScopePicker
                  storeId={storeId}
                  kind="categories"
                  value={form.scopeCategoryIds}
                  onChange={ids => setForm({ ...form, scopeCategoryIds: ids })}
                  label={t('scopeCategories')}
                  searchPlaceholder={t('scopeCategoriesPlaceholder')}
                  emptyHint={t('scopeEmptyHint')}
                  removeLabel={t('scopeRemove')}
                />
              </div>

              <div className="mt-5 flex justify-end gap-2">
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
                  disabled={saving || !form.name.trim() || !form.value}
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
