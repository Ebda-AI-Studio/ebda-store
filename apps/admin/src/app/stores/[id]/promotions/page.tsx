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
import { RowActions } from '@/components/RowActions';
import { BottomSheet } from '@/components/mobile/BottomSheet';
import { useConfirm } from '@/hooks/useConfirm';
import { AdminLayout } from '../../../../components/AdminLayout';
import { apiGet, apiPost, apiPut, apiDelete } from '../../../../lib/api';
import { dateTimeLocalValue } from '@/lib/form-text';
import { ScopePicker } from '../_components/ScopePicker';
import { DataTable, type DataTableColumn } from '@/components/mobile/DataTable';

import { fromMinor, roundToMinor } from '@ebda/shared';
import { formatPrice } from '@/lib/format';
import { Button } from '@/components/ui/Button';
import { FIELD_CLASSES } from '@/components/ui/tokens';
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
  const askConfirm = useConfirm();

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
      // `fixed` promotions are stored in piastres → show as EGP (÷100) in the
      // form. `percentage` promotions store the raw percent, shown as-is.
      value: String(promo.type === 'fixed' ? fromMinor(promo.value) : promo.value),
      maxDiscount: promo.maxDiscount != null ? String(fromMinor(promo.maxDiscount)) : '',
      priority: String(promo.priority),
      isActive: promo.isActive,
      startsAt: dateTimeLocalValue(promo.startsAt),
      expiresAt: dateTimeLocalValue(promo.expiresAt),
      customerGroupId: promo.customerGroupId ?? '',
      firstOrderOnly: promo.firstOrderOnly,
      minOrderAmount: promo.minOrderAmount != null ? String(fromMinor(promo.minOrderAmount)) : '',
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
        // `fixed` promotions: the input is in EGP → store as piastres
        // (×100, via roundToMinor). `percentage` promotions: the value is a percent (e.g. 5 =
        // 5%), stored as-is — NOT money.
        value:
          form.type === 'fixed'
            ? roundToMinor(parseFloat(form.value) || 0)
            : parseInt(form.value, 10) || 0,
        maxDiscount: form.maxDiscount ? roundToMinor(parseFloat(form.maxDiscount)) : null,
        priority: form.priority ? parseInt(form.priority, 10) : 0,
        isActive: form.isActive,
        startsAt: form.startsAt ? new Date(form.startsAt).toISOString() : null,
        expiresAt: form.expiresAt ? new Date(form.expiresAt).toISOString() : null,
        customerGroupId: form.customerGroupId || null,
        firstOrderOnly: form.firstOrderOnly,
        minOrderAmount: form.minOrderAmount ? roundToMinor(parseFloat(form.minOrderAmount)) : null,
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
    const ok = await askConfirm({
      object: t('deleteDialog.object', { name: promo.name }),
      consequence: t('deleteDialog.consequence'),
      confirmLabel: t('deleteDialog.confirmLabel'),
    });
    if (!ok) return;
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

  const columns: DataTableColumn<Promotion>[] = [
    {
      header: t('name'),
      primaryOnMobile: true,
      cell: promo => (
        <>
          <span className="font-medium">{promo.name}</span>
          {promo.nameAr && (
            <span className="ms-2 text-muted-foreground" dir="rtl">
              {promo.nameAr}
            </span>
          )}
        </>
      ),
    },
    {
      header: t('discount'),
      cell: promo => (
        <span className="tabular-nums">
          {promo.type === 'percentage'
            ? t('valuePercentage', { value: promo.value })
            : formatPrice(promo.value)}
        </span>
      ),
    },
    {
      header: t('targeting'),
      cell: promo => (
        <div className="flex flex-wrap gap-1">
          {groupName(promo.customerGroupId) ? (
            <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs">
              {groupName(promo.customerGroupId)}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">{t('allCustomers')}</span>
          )}
          {promo.firstOrderOnly && (
            <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs">
              {t('firstOrderBadge')}
            </span>
          )}
          {(promo.scopeProductIds.length > 0 || promo.scopeCategoryIds.length > 0) && (
            <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs">{t('scopedBadge')}</span>
          )}
        </div>
      ),
    },
    {
      header: t('priority'),
      hideOnMobile: true,
      cell: promo => <span className="tabular-nums">{promo.priority}</span>,
    },
    {
      header: t('status'),
      mobileBadge: true,
      cell: promo => <>{promo.isActive ? t('statusActive') : t('statusInactive')}</>,
    },
    {
      header: t('actions'),
      alignEnd: true,
      mobileActions: true,
      cell: promo => (
        <RowActions
          menuLabel={t('rowMenu', { name: promo.name })}
          primary={
            <Button variant="outline" size="sm" type="button" onClick={() => openEdit(promo)}>
              {t('edit')}
            </Button>
          }
          items={[{ label: t('delete'), destructive: true, onSelect: () => void remove(promo) }]}
        />
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
      <div className="mx-auto max-w-5xl px-4 py-6">
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
        ) : promotions.length === 0 ? (
          <div className="rounded-md border border-dashed py-12 text-center">
            <p className="text-sm font-medium">{t('emptyTitle')}</p>
            <p className="mt-1 text-sm text-muted-foreground">{t('emptyBody')}</p>
            <Button variant="default" size="md" className="mt-4" type="button" onClick={openCreate}>
              {t('addFirst')}
            </Button>
          </div>
        ) : (
          <DataTable<Promotion>
            ariaLabel={t('title')}
            columns={columns}
            rows={promotions}
            rowKey={promo => promo.id}
          />
        )}

        {showModal && (
          <BottomSheet
            open
            onClose={() => setShowModal(false)}
            title={editing ? t('editTitle') : t('createTitle')}
            footer={
              <div className="flex gap-3">
                <Button
                  variant="outline"
                  size="md"
                  className="flex-1"
                  type="button"
                  onClick={() => setShowModal(false)}
                >
                  {t('cancel')}
                </Button>
                <Button
                  variant="default"
                  size="md"
                  className="flex-1"
                  type="submit"
                  form="promotion-form"
                  disabled={saving || !form.name.trim() || !form.value || !(Number(form.value) > 0)}
                >
                  {saving ? t('saving') : t('save')}
                </Button>
              </div>
            }
          >
            <form
              id="promotion-form"
              onSubmit={e => {
                e.preventDefault();
                void save();
              }}
            >
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <label className="block">
                  <span className="mb-1 block text-sm font-medium">{t('name')}</span>
                  <input
                    value={form.name}
                    onChange={e => setForm({ ...form, name: e.target.value })}
                    className={FIELD_CLASSES}
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-sm font-medium">{t('nameAr')}</span>
                  <input
                    value={form.nameAr}
                    onChange={e => setForm({ ...form, nameAr: e.target.value })}
                    dir="rtl"
                    className={FIELD_CLASSES}
                  />
                </label>
              </div>

              <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
                <label className="block">
                  <span className="mb-1 block text-sm font-medium">{t('description')}</span>
                  <input
                    value={form.description}
                    onChange={e => setForm({ ...form, description: e.target.value })}
                    className={FIELD_CLASSES}
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-sm font-medium">{t('descriptionAr')}</span>
                  <input
                    value={form.descriptionAr}
                    onChange={e => setForm({ ...form, descriptionAr: e.target.value })}
                    dir="rtl"
                    className={FIELD_CLASSES}
                  />
                </label>
              </div>

              <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
                <label className="block">
                  <span className="mb-1 block text-sm font-medium">{t('type')}</span>
                  <select
                    value={form.type}
                    onChange={e => setForm({ ...form, type: e.target.value as PromotionType })}
                    className={FIELD_CLASSES}
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
                    step={form.type === 'percentage' ? 1 : 0.01}
                    value={form.value}
                    onChange={e => setForm({ ...form, value: e.target.value })}
                    className={FIELD_CLASSES}
                  />
                </label>
                {form.type === 'percentage' && (
                  <label className="block">
                    <span className="mb-1 block text-sm font-medium">{t('maxDiscount')}</span>
                    <input
                      type="number"
                      min={0}
                      step={0.01}
                      value={form.maxDiscount}
                      onChange={e => setForm({ ...form, maxDiscount: e.target.value })}
                      className={FIELD_CLASSES}
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
                    className={FIELD_CLASSES}
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-sm font-medium">{t('startsAt')}</span>
                  <input
                    type="datetime-local"
                    value={form.startsAt}
                    onChange={e => setForm({ ...form, startsAt: e.target.value })}
                    className={FIELD_CLASSES}
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-sm font-medium">{t('expiresAt')}</span>
                  <input
                    type="datetime-local"
                    value={form.expiresAt}
                    onChange={e => setForm({ ...form, expiresAt: e.target.value })}
                    className={FIELD_CLASSES}
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
                    className={FIELD_CLASSES}
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
                    step={0.01}
                    value={form.minOrderAmount}
                    onChange={e => setForm({ ...form, minOrderAmount: e.target.value })}
                    className={FIELD_CLASSES}
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
                    className={FIELD_CLASSES}
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
            </form>
          </BottomSheet>
        )}
      </div>
    </AdminLayout>
  );
}
