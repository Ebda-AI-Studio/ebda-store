'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { AdminLayout } from '@/components/AdminLayout';
import { DataTable } from '@/components/mobile/DataTable';
import { useT } from '@/i18n/useT';
import { apiGet, apiPost, apiPut, apiDelete } from '@/lib/api';
import { textFieldValue, numericFieldValue } from '@/lib/form-text';
import { useToast } from '@ebda/ui';
import { Button } from '@/components/ui/Button';
import { RowActions } from '@/components/RowActions';
import { useConfirm } from '@/hooks/useConfirm';
import { FIELD_CLASSES } from '@/components/ui/tokens';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Warehouse {
  id: string;
  name: string;
  nameAr: string | null;
  code: string;
  isDefault: boolean;
  priority: number;
  lat: number | null;
  lng: number | null;
  address: string | null;
  isActive: boolean;
  totalSkus: number;
  totalUnits: number;
}

interface WarehouseFormState {
  name: string;
  nameAr: string;
  code: string;
  isDefault: boolean;
  priority: number;
  lat: string;
  lng: string;
  address: string;
}

const EMPTY_FORM: WarehouseFormState = {
  name: '',
  nameAr: '',
  code: '',
  isDefault: false,
  priority: 0,
  lat: '',
  lng: '',
  address: '',
};

// ─── Component ────────────────────────────────────────────────────────────────

export default function WarehousesPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const router = useRouter();
  const t = useT('stock.warehouses');
  const tc = useT('common');
  const askConfirm = useConfirm();
  const { success: toastSuccess, error: toastError } = useToast();

  const [warehouses, setWarehouses] = useState<Warehouse[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // Modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Warehouse | null>(null);
  const [form, setForm] = useState<WarehouseFormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  async function load() {
    setLoading(true);
    setErr(null);
    const { data, error: apiError } = await apiGet<{ warehouses: Warehouse[] }>(
      `/api/v1/stores/${storeId}/warehouses`
    );
    if (apiError) {
      setErr(apiError.message);
    } else {
      setWarehouses(data?.warehouses ?? []);
    }
    setLoading(false);
  }

  useEffect(() => {
    if (storeId) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId]);

  function openNew() {
    setEditTarget(null);
    setForm(EMPTY_FORM);
    setModalOpen(true);
  }

  function openEdit(w: Warehouse) {
    setEditTarget(w);
    setForm({
      name: w.name,
      nameAr: w.nameAr ?? '',
      code: w.code,
      isDefault: w.isDefault,
      priority: w.priority,
      lat: w.lat !== null ? String(w.lat) : '',
      lng: w.lng !== null ? String(w.lng) : '',
      address: w.address ?? '',
    });
    setModalOpen(true);
  }

  async function handleSave() {
    if (!form.name.trim() || !form.code.trim()) {
      toastError(t('validation.nameCodeRequired'));
      return;
    }
    setSaving(true);
    try {
      // Reused by the PUT (edit) branch below — an emptied optional field
      // must send null to actually clear it.
      const intent = editTarget ? 'update' : 'create';
      const payload = {
        name: form.name.trim(),
        nameAr: textFieldValue(form.nameAr.trim(), intent),
        code: form.code.trim(),
        isDefault: form.isDefault,
        priority: form.priority,
        lat: numericFieldValue(form.lat.trim(), intent, parseFloat),
        lng: numericFieldValue(form.lng.trim(), intent, parseFloat),
        address: textFieldValue(form.address.trim(), intent),
      };

      if (editTarget) {
        const { error: putError } = await apiPut(
          `/api/v1/stores/${storeId}/warehouses/${editTarget.id}`,
          payload
        );
        if (putError) throw new Error(putError.message);
        toastSuccess(t('updated'));
      } else {
        const { error: postError } = await apiPost(`/api/v1/stores/${storeId}/warehouses`, payload);
        if (postError) throw new Error(postError.message);
        toastSuccess(t('created'));
      }
      setModalOpen(false);
      await load();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : t('saveFailed');
      toastError(msg);
    } finally {
      setSaving(false);
    }
  }

  async function handleDeactivate(w: Warehouse) {
    const ok = await askConfirm({
      object: t('deactivateObject', { name: w.name }),
      consequence: t('deactivateConsequence'),
      confirmLabel: t('deactivateAction'),
    });
    if (!ok) return;
    try {
      const { error: delError } = await apiDelete(`/api/v1/stores/${storeId}/warehouses/${w.id}`);
      if (delError) throw new Error(delError.message);
      toastSuccess(t('deactivated'));
      await load();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : t('deactivateFailed');
      toastError(msg);
    }
  }

  async function handleSetDefault(w: Warehouse) {
    try {
      const { error: defError } = await apiPut(`/api/v1/stores/${storeId}/warehouses/${w.id}`, {
        isDefault: true,
      });
      if (defError) throw new Error(defError.message);
      toastSuccess(t('defaultSet'));
      await load();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : t('defaultFailed');
      toastError(msg);
    }
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <AdminLayout
      title={t('title')}
      subtitle={t('description')}
      actions={<Button onClick={openNew}>{t('newButton')}</Button>}
    >
      {/* Error banner */}
      {err && (
        <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive-ink">
          {err}{' '}
          <button className="underline" onClick={load}>
            {tc('retry')}
          </button>
        </div>
      )}

      {/* Loading skeleton */}
      {loading && (
        <div className="space-y-2">
          {[1, 2, 3].map(i => (
            <div key={i} className="h-16 animate-pulse rounded-lg bg-muted" />
          ))}
        </div>
      )}

      {/* Warehouse table */}
      {!loading && warehouses && (
        <DataTable<Warehouse>
          ariaLabel={t('title')}
          columns={[
            {
              header: t('colName'),
              primaryOnMobile: true,
              cell: w => <span className="font-medium">{w.name}</span>,
            },
            {
              header: t('colCode'),
              cell: w => <span className="font-mono text-xs text-muted-foreground">{w.code}</span>,
            },
            {
              header: t('colPriority'),
              className: 'text-center',
              hideOnMobile: true,
              cell: w => <span className="text-muted-foreground">{w.priority}</span>,
            },
            {
              header: t('colDefault'),
              className: 'text-center',
              mobileBadge: true,
              cell: w =>
                w.isDefault ? (
                  <span className="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary-ink">
                    {t('default')}
                  </span>
                ) : (
                  <Button
                    onClick={() => handleSetDefault(w)}
                    variant="link"
                    size="sm"
                    className="text-muted-foreground"
                  >
                    {t('setDefault')}
                  </Button>
                ),
            },
            {
              header: t('colSkus'),
              alignEnd: true,
              cell: w => <span className="tabular-nums">{w.totalSkus}</span>,
            },
            {
              header: t('colUnits'),
              alignEnd: true,
              cell: w => <span className="tabular-nums">{w.totalUnits}</span>,
            },
            {
              header: t('colLocation'),
              alignEnd: true,
              hideOnMobile: true,
              cell: w => (
                <span className="text-xs text-muted-foreground">
                  {w.lat !== null && w.lng !== null
                    ? `${w.lat.toFixed(4)}, ${w.lng.toFixed(4)}`
                    : '—'}
                </span>
              ),
            },
            {
              header: tc('actions'),
              alignEnd: true,
              mobileActions: true,
              cell: w => (
                <div className="flex items-center justify-end gap-1">
                  <Button
                    onClick={() => router.push(`/stores/${storeId}/stock/warehouses/${w.id}`)}
                    variant="ghost"
                    size="sm"
                  >
                    {t('viewStock')}
                  </Button>
                  <RowActions
                    menuLabel={t('rowMenu', { name: w.name })}
                    items={[
                      { label: tc('edit'), onSelect: () => openEdit(w) },
                      ...(w.isDefault
                        ? []
                        : [
                            {
                              label: tc('deactivate'),
                              destructive: true,
                              onSelect: () => handleDeactivate(w),
                            },
                          ]),
                    ]}
                  />
                </div>
              ),
            },
          ]}
          rows={warehouses}
          rowKey={w => w.id}
          emptyState={
            <div className="rounded-lg border border-dashed border-border py-16 text-center">
              <p className="text-muted-foreground">{t('empty')}</p>
              <Button onClick={openNew} className="mt-4">
                {t('newButton')}
              </Button>
            </div>
          }
        />
      )}

      {/* Create / Edit Modal */}
      {modalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={e => {
            if (e.target === e.currentTarget) setModalOpen(false);
          }}
        >
          <div className="w-full max-w-lg rounded-md border border-border bg-card p-6 shadow-xl">
            <h2 className="mb-4 text-base font-semibold">
              {editTarget ? t('editTitle') : t('newTitle')}
            </h2>

            <div className="space-y-4">
              {/* Name */}
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-muted-foreground">
                    {t('form.name')} *
                  </span>
                  <input
                    type="text"
                    value={form.name}
                    onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                    className={FIELD_CLASSES}
                    placeholder={t('warehouseNameEnSample')}
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-muted-foreground">
                    {t('form.nameAr')}
                  </span>
                  <input
                    type="text"
                    dir="rtl"
                    value={form.nameAr}
                    onChange={e => setForm(f => ({ ...f, nameAr: e.target.value }))}
                    className={FIELD_CLASSES}
                    placeholder={t('warehouseNameArSample')}
                  />
                </label>
              </div>

              {/* Code + Priority */}
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-muted-foreground">
                    {t('form.code')} *
                  </span>
                  <input
                    type="text"
                    value={form.code}
                    onChange={e => setForm(f => ({ ...f, code: e.target.value.toUpperCase() }))}
                    className={`${FIELD_CLASSES} font-mono`}
                    placeholder="MAIN"
                    maxLength={20}
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-muted-foreground">
                    {t('form.priority')}
                  </span>
                  <input
                    type="number"
                    min={0}
                    max={9999}
                    value={form.priority}
                    onChange={e =>
                      setForm(f => ({ ...f, priority: parseInt(e.target.value) || 0 }))
                    }
                    className={FIELD_CLASSES}
                  />
                </label>
              </div>

              {/* Lat / Lng */}
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-muted-foreground">
                    {t('form.lat')}
                  </span>
                  <input
                    type="number"
                    step="any"
                    value={form.lat}
                    onChange={e => setForm(f => ({ ...f, lat: e.target.value }))}
                    className={FIELD_CLASSES}
                    placeholder="30.0444"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-muted-foreground">
                    {t('form.lng')}
                  </span>
                  <input
                    type="number"
                    step="any"
                    value={form.lng}
                    onChange={e => setForm(f => ({ ...f, lng: e.target.value }))}
                    className={FIELD_CLASSES}
                    placeholder="31.2357"
                  />
                </label>
              </div>

              {/* Address */}
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-muted-foreground">
                  {t('form.address')}
                </span>
                <input
                  type="text"
                  value={form.address}
                  onChange={e => setForm(f => ({ ...f, address: e.target.value }))}
                  className={FIELD_CLASSES}
                  placeholder={t('addressSample')}
                />
              </label>

              {/* Is Default */}
              <label className="flex min-h-[44px] items-center gap-3 rounded-md border border-border px-3">
                <input
                  type="checkbox"
                  checked={form.isDefault}
                  onChange={e => setForm(f => ({ ...f, isDefault: e.target.checked }))}
                  className="h-4 w-4 rounded-md border-input text-primary"
                />
                <span className="text-sm">{t('form.isDefault')}</span>
              </label>
            </div>

            {/* Actions */}
            <div className="mt-6 flex justify-end gap-3">
              <Button variant="ghost" onClick={() => setModalOpen(false)} disabled={saving}>
                {tc('cancel')}
              </Button>
              <Button onClick={handleSave} disabled={saving}>
                {saving ? tc('saving') : tc('save')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </AdminLayout>
  );
}
