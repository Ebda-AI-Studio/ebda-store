'use client';

/**
 * /stores/[id]/bundles — admin CRUD for product bundles (Task 9, against
 * the Task 4 API in apps/api/src/routes/bundle.routes.ts).
 *
 * Structurally mirrors `stores/[id]/promotions/page.tsx` (list + create/edit
 * modal, inline `error` banner, the same field-row/grid layout, the same
 * `t('...')` copy conventions) — see the design-constraint note at the top
 * of this task's brief. Two deliberate deviations from that template:
 *
 *   1. Feature-gated via `useRequireFeature('bundles')` (promotions is
 *      ungated — see hubs.ts's comment on why). `bundles` sits in NO plan
 *      baseline, so every route in bundle.routes.ts 403s without a
 *      per-store `StoreFeature` override; this follows the same
 *      `if (gate) return gate;` pattern as `answer-engine/page.tsx` /
 *      `payment-abandonments/page.tsx`.
 *   2. Items are a product+quantity picker (`BundleItemPicker`), not a
 *      `ScopePicker` id list — a bundle component needs a quantity and a
 *      priced/stocked preview per line, which `ScopePicker` has no room
 *      for. See `orders/new/page.tsx` for the closest existing precedent
 *      (search -> variant picker -> quantity list) this borrows from.
 *
 * Saving uses the ordinary `apiPost`/`apiPut` (RULING T9-a, fix round 1):
 * `bundle.routes.ts`'s `price_not_allocatable` 422 now throws a normal
 * `AppError('PRICE_NOT_ALLOCATABLE', ..., { suggested })`, same envelope as
 * every other error in this app, so `err.code`/`err.details.suggested` is
 * all `save()` needs below — no bespoke fetch/parse path. (A prior version
 * of this file went through `apiFetch` + a hand-rolled parser because the
 * 422 body used to be a one-off shape; that workaround is gone along with
 * the shape that required it.)
 *
 * "Delete" is deliberately never offered as a word in this UI: DELETE
 * /bundles/:id deactivates (`isActive: false`), not a hard delete — see
 * bundle.routes.ts's DELETE handler doc comment (cart_bundles cascades from
 * bundles; a hard delete would silently empty live carts). Reactivating an
 * existing bundle happens by re-opening it for edit and checking "Active"
 * back on, which goes through the ordinary PUT.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams } from 'next/navigation';
import { useLocale } from 'next-intl';
import { computeBundlePrice, isAllocatable, slugify, type BundlePricingType } from '@ebda/shared';
import { useT } from '@/i18n/useT';
import { RowActions } from '@/components/RowActions';
import { BottomSheet } from '@/components/mobile/BottomSheet';
import { useConfirm } from '@/hooks/useConfirm';
import { formatPrice, minorToMajor } from '@/lib/format';
import { AdminLayout } from '../../../../components/AdminLayout';
import { ImageUpload } from '../../../../components/ImageUpload';
import { apiGet, apiPost, apiPut, apiDelete } from '../../../../lib/api';
import { useRequireFeature } from '../../../../hooks/useRequireFeature';
import { BundleItemPicker, type BundleItemRow } from './_components/BundleItemPicker';
import { DataTable, type DataTableColumn } from '@/components/mobile/DataTable';
import { dateTimeLocalValue } from '@/lib/form-text';
import {
  computeAvailability,
  computeComponentSum,
  toBundleLines,
  percentToBasisPoints,
  basisPointsToPercent,
  majorToMinor,
  extractVariantOptions,
  zeroPriceWarning,
  UNTRACKED_AVAILABILITY_CAP,
} from './bundlePricing';

import { Button } from '@/components/ui/Button';
interface BundleLineDTO {
  key: string;
  unitPrice: number;
  quantity: number;
}

interface Bundle {
  id: string;
  name: string;
  nameAr: string | null;
  slug: string;
  description: string | null;
  descriptionAr: string | null;
  image: string | null;
  pricingType: BundlePricingType;
  pricingValue: number;
  componentSum: number;
  price: number;
  available: number;
  lines: BundleLineDTO[];
  isActive: boolean;
  startsAt: string | null;
  expiresAt: string | null;
  isPurchasable: boolean;
}

interface BundleDetailItem {
  id: string;
  productId: string;
  variantId: string | null;
  quantity: number;
  product: { name: string; nameAr: string | null };
  variant: { title: string; titleAr: string | null } | null;
}

interface BundleDetail extends Bundle {
  items: BundleDetailItem[];
}

interface FormState {
  name: string;
  nameAr: string;
  slug: string;
  description: string;
  descriptionAr: string;
  image: string;
  pricingType: BundlePricingType;
  /** Percent (e.g. "12.5") for 'percentage'; EGP (e.g. "11.999") otherwise. */
  pricingValueInput: string;
  isActive: boolean;
  startsAt: string;
  expiresAt: string;
  items: BundleItemRow[];
}

const EMPTY_FORM: FormState = {
  name: '',
  nameAr: '',
  slug: '',
  description: '',
  descriptionAr: '',
  image: '',
  pricingType: 'fixed_price',
  pricingValueInput: '',
  isActive: true,
  startsAt: '',
  expiresAt: '',
  items: [],
};

export default function BundlesPage() {
  const { gate } = useRequireFeature('bundles');

  const params = useParams();
  const storeId = params.id as string;
  const t = useT('bundles.page');
  const askConfirm = useConfirm();
  const locale = useLocale();
  const isRtl = locale === 'ar';

  const displayName = (name: string, nameAr?: string | null) =>
    isRtl ? nameAr || name : name || nameAr || name;

  const [bundles, setBundles] = useState<Bundle[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [slugTouched, setSlugTouched] = useState(false);
  const [allocationSuggestion, setAllocationSuggestion] = useState<number | null>(null);

  const fetchBundles = useCallback(async () => {
    try {
      const { data } = await apiGet<{ bundles: Bundle[] }>(`/api/v1/stores/${storeId}/bundles`);
      setBundles(data?.bundles ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [storeId, t]);

  useEffect(() => {
    void fetchBundles();
  }, [fetchBundles]);

  const openCreate = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setSlugTouched(false);
    setAllocationSuggestion(null);
    setShowModal(true);
  };

  // Component rows come back from `resolveBundle`'s `lines` (priced,
  // keyed by BundleItem id) joined with the raw `items` (product names +
  // ids). Neither carries stock/tracking data, so one batched product fetch
  // (by id) plus one variants fetch per unique product-with-a-pinned-variant
  // hydrates it — same "fetch extra detail for already-known ids" shape as
  // `ScopePicker`'s label hydration.
  const hydrateItemRows = useCallback(
    async (detail: BundleDetail): Promise<BundleItemRow[]> => {
      const lineByItemId = new Map(detail.lines.map(l => [l.key, l]));
      const productIds = [...new Set(detail.items.map(i => i.productId))];

      const productById = new Map<string, { trackInventory: boolean; totalInventory: number }>();
      if (productIds.length > 0) {
        const { data } = await apiGet<{
          products: Array<{ id: string; trackInventory: boolean; totalInventory: number }>;
        }>(
          `/api/v1/stores/${storeId}/products?ids=${productIds.join(',')}&limit=${productIds.length}`
        );
        for (const p of data?.products ?? []) productById.set(p.id, p);
      }

      const variantProductIds = [
        ...new Set(detail.items.filter(i => i.variantId).map(i => i.productId)),
      ];
      const variantInventoryById = new Map<string, number>();
      await Promise.all(
        variantProductIds.map(async pid => {
          const { data } = await apiGet<{ variants: Array<{ id: string; inventory: number }> }>(
            `/api/v1/stores/${storeId}/products/${pid}/variants`
          );
          for (const v of extractVariantOptions(data)) variantInventoryById.set(v.id, v.inventory);
        })
      );

      return detail.items.map(item => {
        const line = lineByItemId.get(item.id);
        const product = productById.get(item.productId);
        const name = item.variant
          ? `${displayName(item.product.name, item.product.nameAr)} — ${displayName(item.variant.title, item.variant.titleAr)}`
          : displayName(item.product.name, item.product.nameAr);
        return {
          productId: item.productId,
          variantId: item.variantId,
          name,
          unitPrice: line?.unitPrice ?? 0,
          quantity: item.quantity,
          trackInventory: product?.trackInventory ?? true,
          availableStock: item.variantId
            ? (variantInventoryById.get(item.variantId) ?? 0)
            : (product?.totalInventory ?? 0),
        };
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [storeId]
  );

  const openEdit = async (bundle: Bundle) => {
    setError(null);
    setAllocationSuggestion(null);
    setLoadingDetail(true);
    try {
      const { data, error: fetchError } = await apiGet<{ bundle: BundleDetail }>(
        `/api/v1/stores/${storeId}/bundles/${bundle.id}`
      );
      if (fetchError || !data?.bundle) {
        setError(fetchError?.message || t('loadFailed'));
        return;
      }
      const detail = data.bundle;
      const items = await hydrateItemRows(detail);
      setEditingId(detail.id);
      setForm({
        name: detail.name,
        nameAr: detail.nameAr ?? '',
        slug: detail.slug,
        description: detail.description ?? '',
        descriptionAr: detail.descriptionAr ?? '',
        image: detail.image ?? '',
        pricingType: detail.pricingType,
        pricingValueInput:
          detail.pricingType === 'percentage'
            ? String(basisPointsToPercent(detail.pricingValue))
            : minorToMajor(detail.pricingValue),
        isActive: detail.isActive,
        startsAt: dateTimeLocalValue(detail.startsAt),
        expiresAt: dateTimeLocalValue(detail.expiresAt),
        items,
      });
      setSlugTouched(true); // editing an existing slug should never auto-rewrite
      setShowModal(true);
    } finally {
      setLoadingDetail(false);
    }
  };

  const handleNameChange = (name: string) => {
    setForm(f => ({ ...f, name, slug: slugTouched ? f.slug : slugify(name) }));
  };

  // ─── Live preview (requirements 1 + 2) ──────────────────────────────────
  const componentSum = useMemo(() => computeComponentSum(form.items), [form.items]);
  const lines = useMemo(() => toBundleLines(form.items), [form.items]);
  const pricingValueFils = useMemo(
    () =>
      form.pricingType === 'percentage'
        ? percentToBasisPoints(parseFloat(form.pricingValueInput) || 0)
        : majorToMinor(form.pricingValueInput),
    [form.pricingType, form.pricingValueInput]
  );
  const derivedPrice = useMemo(
    () => computeBundlePrice(componentSum, form.pricingType, pricingValueFils),
    [componentSum, form.pricingType, pricingValueFils]
  );
  const derivedAvailability = useMemo(
    () =>
      computeAvailability(
        form.items.map(it => ({
          quantity: it.quantity,
          trackInventory: it.trackInventory,
          availableStock: it.availableStock,
        }))
      ),
    [form.items]
  );
  // Soft, pre-submit heads-up computed from the SAME prices the merchant is
  // currently looking at — the definitive check (and the "use suggested"
  // fix) is `allocationSuggestion`, set only from the server's real 422, since
  // only the server's componentSum is authoritative at save time.
  const looksUnallocatable = form.items.length > 0 && !isAllocatable(lines, derivedPrice);
  // P1: the two ways the editor can be showing a price of 0 that the server
  // will refuse to sell — the arithmetic lives in `zeroPriceWarning` (pure,
  // unit-tested) rather than inline in the JSX below, per Ruling P2-c: a
  // predicate that only exists inside a component can only be "tested" by
  // grepping the source. Soft and pre-submit, same posture as
  // `looksUnallocatable`: the server's componentSum is the authoritative one
  // at save time.
  const priceWarning = zeroPriceWarning({
    pricingType: form.pricingType,
    componentSum,
    pricingValueFils,
    derivedPrice,
    itemCount: form.items.length,
  });

  const applySuggestedPrice = (suggestedFils: number) => {
    // Re-expressing the discount as a `fixed_price` is the only edit that is
    // ALWAYS correct regardless of the merchant's current pricing type —
    // `nearestAllocatablePrice` guarantees `suggestedFils` itself allocates
    // exactly, so setting it as a literal price can never reintroduce the
    // same error.
    setForm(f => ({
      ...f,
      pricingType: 'fixed_price',
      pricingValueInput: minorToMajor(suggestedFils),
    }));
    setAllocationSuggestion(null);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    setAllocationSuggestion(null);
    try {
      const body = {
        name: form.name.trim(),
        nameAr: form.nameAr.trim() || null,
        slug: form.slug.trim(),
        description: form.description.trim() || null,
        descriptionAr: form.descriptionAr.trim() || null,
        image: form.image.trim() || null,
        pricingType: form.pricingType,
        pricingValue: pricingValueFils,
        isActive: form.isActive,
        startsAt: form.startsAt ? new Date(form.startsAt).toISOString() : null,
        expiresAt: form.expiresAt ? new Date(form.expiresAt).toISOString() : null,
        items: form.items.map(it => ({
          productId: it.productId,
          variantId: it.variantId ?? null,
          quantity: it.quantity,
        })),
      };

      const { error: saveError } = editingId
        ? await apiPut(`/api/v1/stores/${storeId}/bundles/${editingId}`, body)
        : await apiPost(`/api/v1/stores/${storeId}/bundles`, body);

      if (saveError) {
        // RULING T9-a: `price_not_allocatable` is now a normal AppError
        // (`code: 'PRICE_NOT_ALLOCATABLE'`, `suggested` in `details`) — the
        // standard envelope `apiPost`/`apiPut` already parse, no special
        // fetch path needed.
        const suggested = saveError.details?.suggested;
        if (saveError.code === 'PRICE_NOT_ALLOCATABLE' && typeof suggested === 'number') {
          setAllocationSuggestion(suggested);
        } else if (saveError.code === 'PRICE_ABOVE_COMPONENT_SUM') {
          // The API's own message is English-only (as every AppError in that
          // app is); this is the one merchant-facing save error whose text
          // the Arabic admin would otherwise show in English. `details`
          // carries the SERVER's componentSum, which is the authoritative
          // one — the picker's own copy can be stale by the time the
          // request lands. Which of the two ceilings was hit is decided by
          // the pricing type the merchant is currently editing, the same
          // way the server decided it.
          const serverSum = saveError.details?.componentSum;
          const sum = formatPrice(typeof serverSum === 'number' ? serverSum : componentSum);
          setError(
            t(
              form.pricingType === 'fixed' ? 'discountAboveComponentSum' : 'priceAboveComponentSum',
              { sum }
            )
          );
        } else {
          setError(saveError.message || t('saveFailed'));
        }
        return;
      }

      setShowModal(false);
      await fetchBundles();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const deactivate = async (bundle: Bundle) => {
    const ok = await askConfirm({
      object: t('deactivateDialog.object', { name: bundle.name }),
      consequence: t('deactivateDialog.consequence'),
      confirmLabel: t('deactivateDialog.confirmLabel'),
    });
    if (!ok) return;
    setError(null);
    try {
      const { error: err } = await apiDelete(`/api/v1/stores/${storeId}/bundles/${bundle.id}`);
      if (err) {
        setError(err.message || t('deactivateFailed'));
        return;
      }
      await fetchBundles();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('deactivateFailed'));
    }
  };

  const columns: DataTableColumn<Bundle>[] = [
    {
      header: t('name'),
      primaryOnMobile: true,
      cell: bundle => (
        <>
          <span className="font-medium">{bundle.name}</span>
          {bundle.nameAr && (
            <span className="ms-2 text-muted-foreground" dir="rtl">
              {bundle.nameAr}
            </span>
          )}
        </>
      ),
    },
    {
      header: t('items'),
      hideOnMobile: true,
      cell: bundle => (
        <span className="tabular-nums">{t('itemsCount', { count: bundle.lines.length })}</span>
      ),
    },
    {
      header: t('price'),
      cell: bundle => (
        <span className="tabular-nums">
          <span className="font-medium">{formatPrice(bundle.price)}</span>
          <span className="ms-1.5 text-xs text-muted-foreground">
            {t('ofComponentSum', { sum: formatPrice(bundle.componentSum) })}
          </span>
        </span>
      ),
    },
    {
      header: t('availability'),
      cell: bundle => (
        <span className="tabular-nums">
          {bundle.available >= UNTRACKED_AVAILABILITY_CAP
            ? t('unlimited')
            : t('availableCount', { count: bundle.available })}
        </span>
      ),
    },
    {
      header: t('status'),
      mobileBadge: true,
      cell: bundle => (
        <>
          {bundle.isActive ? t('statusActive') : t('statusInactive')}
          {bundle.isActive && !bundle.isPurchasable && (
            <span className="ms-1.5 text-xs text-muted-foreground">{t('notPurchasableHint')}</span>
          )}
        </>
      ),
    },
    {
      header: t('actions'),
      alignEnd: true,
      mobileActions: true,
      cell: bundle => (
        <RowActions
          menuLabel={t('rowMenu', { name: bundle.name })}
          primary={
            <Button type="button" onClick={() => void openEdit(bundle)} variant="outline">
              {t('edit')}
            </Button>
          }
          items={
            bundle.isActive
              ? [
                  {
                    label: t('deactivate'),
                    destructive: true,
                    onSelect: () => void deactivate(bundle),
                  },
                ]
              : []
          }
        />
      ),
    },
  ];

  if (gate) return gate;

  return (
    <AdminLayout
      title={t('title')}
      subtitle={t('subtitle')}
      mode="store_admin"
      storeId={storeId}
      actions={
        <Button type="button" onClick={openCreate} variant="default">
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
        ) : bundles.length === 0 ? (
          <div className="rounded-md border border-dashed py-12 text-center">
            <p className="text-sm font-medium">{t('emptyTitle')}</p>
            <p className="mt-1 text-sm text-muted-foreground">{t('emptyBody')}</p>
            <Button type="button" onClick={openCreate} variant="default" className="mt-4">
              {t('addFirst')}
            </Button>
          </div>
        ) : (
          <DataTable<Bundle>
            ariaLabel={t('title')}
            columns={columns}
            rows={bundles}
            rowKey={bundle => bundle.id}
          />
        )}

        {loadingDetail && (
          <p className="mt-4 text-center text-sm text-muted-foreground">{t('loading')}</p>
        )}

        {showModal && (
          <BottomSheet
            open
            onClose={() => setShowModal(false)}
            title={editingId ? t('editTitle') : t('createTitle')}
            footer={
              <div className="flex gap-3">
                <Button
                  type="button"
                  onClick={() => setShowModal(false)}
                  variant="outline"
                  className="flex-1"
                >
                  {t('cancel')}
                </Button>
                <Button
                  type="submit"
                  form="bundle-form"
                  disabled={
                    saving || !form.name.trim() || !form.slug.trim() || form.items.length === 0
                  }
                  variant="default"
                  className="flex-1"
                >
                  {saving ? t('saving') : t('save')}
                </Button>
              </div>
            }
          >
            <form
              id="bundle-form"
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
                    onChange={e => handleNameChange(e.target.value)}
                    className="w-full rounded-md border border-input px-3 py-2 text-sm"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-sm font-medium">{t('nameAr')}</span>
                  <input
                    value={form.nameAr}
                    onChange={e => setForm({ ...form, nameAr: e.target.value })}
                    dir="rtl"
                    className="w-full rounded-md border border-input px-3 py-2 text-sm"
                  />
                </label>
              </div>

              <label className="mt-3 block">
                <span className="mb-1 block text-sm font-medium">{t('slug')}</span>
                <input
                  value={form.slug}
                  onChange={e => {
                    setSlugTouched(true);
                    setForm({ ...form, slug: e.target.value });
                  }}
                  dir="ltr"
                  className="w-full rounded-md border border-input px-3 py-2 text-sm"
                />
              </label>

              <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
                <label className="block">
                  <span className="mb-1 block text-sm font-medium">{t('description')}</span>
                  <input
                    value={form.description}
                    onChange={e => setForm({ ...form, description: e.target.value })}
                    className="w-full rounded-md border border-input px-3 py-2 text-sm"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-sm font-medium">{t('descriptionAr')}</span>
                  <input
                    value={form.descriptionAr}
                    onChange={e => setForm({ ...form, descriptionAr: e.target.value })}
                    dir="rtl"
                    className="w-full rounded-md border border-input px-3 py-2 text-sm"
                  />
                </label>
              </div>

              <div className="mt-3">
                <span className="mb-1 block text-sm font-medium">{t('image')}</span>
                <ImageUpload
                  value={form.image || undefined}
                  onUpload={url => setForm({ ...form, image: url })}
                  onRemove={() => setForm({ ...form, image: '' })}
                  folder="misc"
                  storeId={storeId}
                  label={t('uploadImage')}
                />
              </div>

              <hr className="my-4 border-border" />
              <h3 className="mb-3 text-sm font-semibold">{t('pricingHeading')}</h3>

              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <label className="block">
                  <span className="mb-1 block text-sm font-medium">{t('pricingType')}</span>
                  <select
                    value={form.pricingType}
                    onChange={e =>
                      setForm({ ...form, pricingType: e.target.value as BundlePricingType })
                    }
                    className="w-full rounded-md border border-input px-3 py-2 text-sm"
                  >
                    <option value="fixed_price">{t('pricingTypeFixedPrice')}</option>
                    <option value="percentage">{t('pricingTypePercentage')}</option>
                    <option value="fixed">{t('pricingTypeFixed')}</option>
                  </select>
                </label>
                <label className="block">
                  <span className="mb-1 block text-sm font-medium">
                    {form.pricingType === 'fixed_price'
                      ? t('pricingValueLabelFixedPrice')
                      : form.pricingType === 'percentage'
                        ? t('pricingValueLabelPercentage')
                        : t('pricingValueLabelFixed')}
                  </span>
                  <input
                    type="number"
                    min={0}
                    // The ceiling the SERVER enforces, shown before the
                    // merchant saves: 100% for a percentage, and the
                    // components' own total for either piastres-denominated type
                    // (`assertPriceWithinComponentSum` in bundle.routes.ts
                    // 422s above it). Left undefined while there are no
                    // components — a `max` of 0.000 on an empty picker reads
                    // as "you may not type anything", which is not the rule.
                    // Advisory only, exactly like `mayNotSplitEvenly` below:
                    // the merchant's own componentSum can be stale, so the
                    // server's is still the authoritative one.
                    max={
                      form.pricingType === 'percentage'
                        ? 100
                        : componentSum > 0
                          ? minorToMajor(componentSum)
                          : undefined
                    }
                    step={form.pricingType === 'percentage' ? 0.01 : 0.01}
                    value={form.pricingValueInput}
                    onChange={e => setForm({ ...form, pricingValueInput: e.target.value })}
                    className="w-full rounded-md border border-input px-3 py-2 text-sm"
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

              <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
                <label className="block">
                  <span className="mb-1 block text-sm font-medium">{t('startsAt')}</span>
                  <input
                    type="datetime-local"
                    value={form.startsAt}
                    onChange={e => setForm({ ...form, startsAt: e.target.value })}
                    className="w-full rounded-md border border-input px-3 py-2 text-sm"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-sm font-medium">{t('expiresAt')}</span>
                  <input
                    type="datetime-local"
                    value={form.expiresAt}
                    onChange={e => setForm({ ...form, expiresAt: e.target.value })}
                    className="w-full rounded-md border border-input px-3 py-2 text-sm"
                  />
                </label>
              </div>

              <hr className="my-4 border-border" />
              <h3 className="mb-3 text-sm font-semibold">{t('itemsHeading')}</h3>

              <BundleItemPicker
                storeId={storeId}
                value={form.items}
                onChange={items => setForm({ ...form, items })}
              />

              {/* Live preview — requirements 1 + 2 (component sum / derived
                  price, derived availability) are computed from `form.items`
                  on every keystroke via the useMemo block above, so this
                  panel never falls behind the picker. */}
              <div className="mt-4 space-y-1 rounded-md border border-border bg-muted/30 p-3 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">{t('componentSum')}</span>
                  <span className="font-medium tabular-nums">{formatPrice(componentSum)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">{t('derivedPrice')}</span>
                  <span className="font-semibold tabular-nums">{formatPrice(derivedPrice)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">{t('derivedAvailability')}</span>
                  <span className="font-medium tabular-nums">
                    {derivedAvailability >= UNTRACKED_AVAILABILITY_CAP
                      ? t('unlimited')
                      : t('availableCount', { count: derivedAvailability })}
                  </span>
                </div>
                {priceWarning && (
                  <p className="pt-1 text-xs text-destructive-ink">
                    {t(priceWarning, { sum: formatPrice(componentSum) })}
                  </p>
                )}
                {looksUnallocatable && !allocationSuggestion && (
                  <p className="pt-1 text-xs text-muted-foreground">{t('mayNotSplitEvenly')}</p>
                )}
              </div>

              {/* Requirement 3: the price_not_allocatable 422, surfaced
                  inline on the price with the suggested value one click
                  away. */}
              {allocationSuggestion !== null && (
                <div
                  role="alert"
                  className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive-ink"
                >
                  <p>
                    {t('priceNotAllocatable', {
                      price: minorToMajor(derivedPrice),
                      suggested: minorToMajor(allocationSuggestion),
                    })}
                  </p>
                  <Button
                    type="button"
                    onClick={() => applySuggestedPrice(allocationSuggestion)}
                    variant="outline"
                    size="sm"
                    className="mt-1.5"
                  >
                    {t('useSuggested', { suggested: minorToMajor(allocationSuggestion) })}
                  </Button>
                </div>
              )}

              {error && (
                <div
                  role="alert"
                  className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive-ink"
                >
                  {error}
                </div>
              )}
            </form>
          </BottomSheet>
        )}
      </div>
    </AdminLayout>
  );
}
