'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { useLocale } from 'next-intl';
import { Modal } from '@ebda/ui';
import { AdminLayout } from '@/components/AdminLayout';
import { DataTable } from '@/components/mobile/DataTable';
import { PageState } from '@/components/PageState';
import { RowActions } from '@/components/RowActions';
import { Button } from '@/components/ui/Button';
import { useConfirm } from '@/hooks/useConfirm';
import { useT } from '@/i18n/useT';
import { apiDelete, apiGet, apiPatch, apiPost } from '@/lib/api';

interface Rule {
  id: string;
  productId: string;
  variantId: string | null;
  minQty: number;
  reorderQty: number;
  leadTimeDays: number;
  safetyStockDays: number;
  preferredSupplierId: string | null;
  isActive: boolean;
  product: { id: string; name: string; nameAr: string | null; sku: string | null };
  variant: { id: string; title: string; titleAr: string | null; sku: string | null } | null;
  preferredSupplier: { id: string; name: string } | null;
}
interface ProductOption {
  id: string;
  name: string;
  sku: string | null;
}
interface VariantOption {
  id: string;
  title: string;
  sku: string | null;
}
interface SupplierOption {
  id: string;
  name: string;
}

interface Draft {
  productId: string;
  variantId: string;
  minQty: string;
  reorderQty: string;
  leadTimeDays: string;
  safetyStockDays: string;
  preferredSupplierId: string;
  isActive: boolean;
}

const EMPTY: Draft = {
  productId: '',
  variantId: '',
  minQty: '',
  reorderQty: '',
  leadTimeDays: '7',
  safetyStockDays: '7',
  preferredSupplierId: '',
  isActive: true,
};

const FIELD = 'w-full border border-border rounded px-2 py-1.5 text-base sm:text-sm bg-background';

function intOrNull(v: string): number | null {
  return /^\d+$/.test(v.trim()) ? parseInt(v, 10) : null;
}

export default function ReorderRulesPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const isAr = useLocale() === 'ar';
  const t = useT('stock.reorderRules');
  const tc = useT('common');
  const askConfirm = useConfirm();

  const [rules, setRules] = useState<Rule[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [suppliers, setSuppliers] = useState<SupplierOption[]>([]);
  const [variants, setVariants] = useState<VariantOption[]>([]);

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Rule | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!storeId) return;
    const { data, error: apiError } = await apiGet<Rule[]>(
      `/api/v1/stores/${storeId}/stock/reorder-rules`
    );
    if (apiError) setError(apiError.message);
    else setRules(data ?? []);
  }, [storeId]);

  useEffect(() => {
    load();
  }, [load]);

  // Pickers load once, when the form is first opened.
  useEffect(() => {
    if (!open || !storeId || products.length > 0) return;
    apiGet<{ products: ProductOption[] }>(`/api/v1/stores/${storeId}/products?limit=200`).then(
      ({ data }) => setProducts(data?.products ?? [])
    );
    apiGet<SupplierOption[]>(`/api/v1/stores/${storeId}/suppliers`).then(({ data }) =>
      setSuppliers(data ?? [])
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, storeId]);

  // Variants of the chosen product (a create picks product + optional variant; an edit cannot change them).
  useEffect(() => {
    if (!open || editing || !draft.productId) {
      setVariants([]);
      return;
    }
    let live = true;
    apiGet<{ variants?: VariantOption[] }>(
      `/api/v1/stores/${storeId}/products/${draft.productId}/variants`
    ).then(({ data }) => {
      if (live) setVariants(data?.variants ?? []);
    });
    return () => {
      live = false;
    };
  }, [open, editing, draft.productId, storeId]);

  function openCreate() {
    setEditing(null);
    setDraft(EMPTY);
    setFormError(null);
    setOpen(true);
  }

  function openEdit(r: Rule) {
    setEditing(r);
    setDraft({
      productId: r.productId,
      variantId: r.variantId ?? '',
      minQty: String(r.minQty),
      reorderQty: String(r.reorderQty),
      leadTimeDays: String(r.leadTimeDays),
      safetyStockDays: String(r.safetyStockDays),
      preferredSupplierId: r.preferredSupplierId ?? '',
      isActive: r.isActive,
    });
    setFormError(null);
    setOpen(true);
  }

  async function save() {
    const minQty = intOrNull(draft.minQty);
    const reorderQty = intOrNull(draft.reorderQty);
    const leadTimeDays = intOrNull(draft.leadTimeDays);
    const safetyStockDays = intOrNull(draft.safetyStockDays);
    if (
      (!editing && !draft.productId) ||
      minQty === null ||
      reorderQty === null ||
      reorderQty < 1 ||
      leadTimeDays === null ||
      safetyStockDays === null
    ) {
      setFormError(t('form.invalid'));
      return;
    }
    setSaving(true);
    setFormError(null);
    const common = {
      minQty,
      reorderQty,
      leadTimeDays,
      safetyStockDays,
      preferredSupplierId: draft.preferredSupplierId || null,
      isActive: draft.isActive,
    };
    const base = `/api/v1/stores/${storeId}/stock/reorder-rules`;
    const { error: apiError } = editing
      ? await apiPatch(`${base}/${editing.id}`, common)
      : await apiPost(base, {
          ...common,
          productId: draft.productId,
          variantId: draft.variantId || null,
        });
    setSaving(false);
    if (apiError) {
      setFormError(apiError.status === 409 ? t('form.duplicate') : t('form.saveFailed'));
      return;
    }
    setOpen(false);
    await load();
  }

  async function remove(r: Rule) {
    const ok = await askConfirm({
      object: t('deleteObject', { name: ruleName(r) }),
      consequence: t('deleteConsequence'),
      confirmLabel: t('deleteAction'),
    });
    if (!ok) return;
    const { error: apiError } = await apiDelete(
      `/api/v1/stores/${storeId}/stock/reorder-rules/${r.id}`
    );
    if (apiError) setError(t('deleteFailed'));
    else await load();
  }

  function ruleName(r: Rule): string {
    const p = (isAr && r.product.nameAr) || r.product.name;
    const v = r.variant ? (isAr && r.variant.titleAr) || r.variant.title : null;
    return v ? `${p} / ${v}` : p;
  }

  const num = (k: keyof Draft, label: string, min: number) => (
    <label className="block space-y-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <input
        type="number"
        inputMode="numeric"
        min={min}
        step={1}
        value={draft[k] as string}
        onChange={e => setDraft(d => ({ ...d, [k]: e.target.value }))}
        className={FIELD}
      />
    </label>
  );

  return (
    <AdminLayout
      title={t('title')}
      subtitle={t('description')}
      actions={<Button onClick={openCreate}>{t('newButton')}</Button>}
    >
      <div className="max-w-4xl space-y-4">
        <PageState
          loading={!rules && !error}
          error={error}
          onRetry={() => {
            setError(null);
            load();
          }}
        >
          <DataTable<Rule>
            ariaLabel={t('title')}
            columns={[
              {
                header: t('col.item'),
                primaryOnMobile: true,
                cell: r => (
                  <span className="block max-w-[16rem] truncate font-medium">{ruleName(r)}</span>
                ),
              },
              { header: t('col.minQty'), alignEnd: true, cell: r => r.minQty },
              { header: t('col.reorderQty'), alignEnd: true, cell: r => r.reorderQty },
              {
                header: t('col.supplier'),
                hideOnMobile: true,
                cell: r => (
                  <span className="text-muted-foreground">{r.preferredSupplier?.name ?? '—'}</span>
                ),
              },
              {
                header: t('col.active'),
                mobileBadge: true,
                className: 'w-20 text-center',
                cell: r => <span className="text-muted-foreground">{r.isActive ? '✓' : '—'}</span>,
              },
              {
                header: '',
                alignEnd: true,
                mobileActions: true,
                className: 'w-28',
                cell: r => (
                  <RowActions
                    menuLabel={t('rowMenu', { name: ruleName(r) })}
                    items={[
                      { label: tc('edit'), onSelect: () => openEdit(r) },
                      { label: tc('delete'), destructive: true, onSelect: () => remove(r) },
                    ]}
                  />
                ),
              },
            ]}
            rows={rules ?? []}
            rowKey={r => r.id}
            emptyState={<p className="text-sm text-muted-foreground">{t('empty')}</p>}
          />
        </PageState>
      </div>

      <Modal
        isOpen={open}
        onClose={() => !saving && setOpen(false)}
        title={editing ? t('form.editTitle') : t('form.createTitle')}
        size="md"
      >
        <div className="space-y-3">
          {editing ? (
            <p className="text-sm font-medium">{ruleName(editing)}</p>
          ) : (
            <>
              <label className="block space-y-1 text-sm">
                <span className="text-muted-foreground">{t('form.product')}</span>
                <select
                  value={draft.productId}
                  onChange={e =>
                    setDraft(d => ({ ...d, productId: e.target.value, variantId: '' }))
                  }
                  className={FIELD}
                >
                  <option value="">— {t('form.product')} —</option>
                  {products.map(p => (
                    <option key={p.id} value={p.id}>
                      {p.sku ? `[${p.sku}] ` : ''}
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              {variants.length > 0 && (
                <label className="block space-y-1 text-sm">
                  <span className="text-muted-foreground">{t('form.variant')}</span>
                  <select
                    value={draft.variantId}
                    onChange={e => setDraft(d => ({ ...d, variantId: e.target.value }))}
                    className={FIELD}
                  >
                    <option value="">{t('form.wholeProduct')}</option>
                    {variants.map(v => (
                      <option key={v.id} value={v.id}>
                        {v.title}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </>
          )}
          <div className="grid grid-cols-2 gap-3">
            {num('minQty', t('form.minQty'), 0)}
            {num('reorderQty', t('form.reorderQty'), 1)}
            {num('leadTimeDays', t('form.leadTimeDays'), 0)}
            {num('safetyStockDays', t('form.safetyStockDays'), 0)}
          </div>
          <label className="block space-y-1 text-sm">
            <span className="text-muted-foreground">{t('form.supplier')}</span>
            <select
              value={draft.preferredSupplierId}
              onChange={e => setDraft(d => ({ ...d, preferredSupplierId: e.target.value }))}
              className={FIELD}
            >
              <option value="">{t('form.noSupplier')}</option>
              {suppliers.map(s => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.isActive}
              onChange={e => setDraft(d => ({ ...d, isActive: e.target.checked }))}
            />
            <span>{t('form.active')}</span>
          </label>
          {formError && (
            <p role="alert" className="text-sm text-red-600">
              {formError}
            </p>
          )}
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>
              {tc('cancel')}
            </Button>
            <Button onClick={save} disabled={saving} isLoading={saving}>
              {tc('save')}
            </Button>
          </div>
        </div>
      </Modal>
    </AdminLayout>
  );
}
