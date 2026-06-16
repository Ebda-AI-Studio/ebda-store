'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { AdminLayout } from '@/components/AdminLayout';
import { useT } from '@/i18n/useT';
import { apiGet, apiPost, apiPut, apiDelete } from '@/lib/api';
import { Button, useToast } from '@force/ui';

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
      const payload = {
        name: form.name.trim(),
        nameAr: form.nameAr.trim() || undefined,
        code: form.code.trim(),
        isDefault: form.isDefault,
        priority: form.priority,
        lat: form.lat !== '' ? parseFloat(form.lat) : undefined,
        lng: form.lng !== '' ? parseFloat(form.lng) : undefined,
        address: form.address.trim() || undefined,
      };

      if (editTarget) {
        await apiPut(`/api/v1/stores/${storeId}/warehouses/${editTarget.id}`, payload);
        toastSuccess(t('updated'));
      } else {
        await apiPost(`/api/v1/stores/${storeId}/warehouses`, payload);
        toastSuccess(t('created'));
      }
      setModalOpen(false);
      await load();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Save failed';
      toastError(msg);
    } finally {
      setSaving(false);
    }
  }

  async function handleDeactivate(w: Warehouse) {
    if (!confirm(t('deactivateConfirm', { name: w.name }))) return;
    try {
      await apiDelete(`/api/v1/stores/${storeId}/warehouses/${w.id}`);
      toastSuccess(t('deactivated'));
      await load();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to deactivate';
      toastError(msg);
    }
  }

  async function handleSetDefault(w: Warehouse) {
    try {
      await apiPut(`/api/v1/stores/${storeId}/warehouses/${w.id}`, { isDefault: true });
      toastSuccess(t('defaultSet'));
      await load();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to set default';
      toastError(msg);
    }
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <AdminLayout
      title={t('title')}
      subtitle={t('description')}
      actions={
        <Button onClick={openNew} className="min-h-[44px]">
          {t('newButton')}
        </Button>
      }
    >
      {/* Error banner */}
      {err && (
        <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
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

      {/* Empty state */}
      {!loading && !err && warehouses?.length === 0 && (
        <div className="rounded-lg border border-dashed border-border py-16 text-center">
          <p className="text-muted-foreground">{t('empty')}</p>
          <Button onClick={openNew} className="mt-4 min-h-[44px]">
            {t('newButton')}
          </Button>
        </div>
      )}

      {/* Warehouse table */}
      {!loading && warehouses && warehouses.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3 text-start">{t('colName')}</th>
                <th className="px-4 py-3 text-start">{t('colCode')}</th>
                <th className="px-4 py-3 text-center">{t('colPriority')}</th>
                <th className="px-4 py-3 text-center">{t('colDefault')}</th>
                <th className="px-4 py-3 text-end">{t('colSkus')}</th>
                <th className="px-4 py-3 text-end">{t('colUnits')}</th>
                <th className="px-4 py-3 text-end">{t('colLocation')}</th>
                <th className="px-4 py-3 text-end">{tc('actions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {warehouses.map(w => (
                <tr key={w.id} className="transition-colors hover:bg-muted/30">
                  <td className="px-4 py-3 font-medium">{w.name}</td>
                  <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{w.code}</td>
                  <td className="px-4 py-3 text-center text-muted-foreground">{w.priority}</td>
                  <td className="px-4 py-3 text-center">
                    {w.isDefault ? (
                      <span className="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                        {t('default')}
                      </span>
                    ) : (
                      <button
                        onClick={() => handleSetDefault(w)}
                        className="text-xs text-muted-foreground underline hover:text-foreground"
                      >
                        {t('setDefault')}
                      </button>
                    )}
                  </td>
                  <td className="px-4 py-3 text-end tabular-nums">{w.totalSkus}</td>
                  <td className="px-4 py-3 text-end tabular-nums">{w.totalUnits}</td>
                  <td className="px-4 py-3 text-end text-xs text-muted-foreground">
                    {w.lat !== null && w.lng !== null
                      ? `${w.lat.toFixed(4)}, ${w.lng.toFixed(4)}`
                      : '—'}
                  </td>
                  <td className="px-4 py-3 text-end">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() => router.push(`/stores/${storeId}/stock/warehouses/${w.id}`)}
                        className="min-h-[44px] rounded-md px-3 text-xs font-medium text-primary hover:bg-primary/10"
                      >
                        {t('viewStock')}
                      </button>
                      <button
                        onClick={() => openEdit(w)}
                        className="min-h-[44px] rounded-md px-3 text-xs font-medium hover:bg-muted"
                      >
                        {tc('edit')}
                      </button>
                      {!w.isDefault && (
                        <button
                          onClick={() => handleDeactivate(w)}
                          className="min-h-[44px] rounded-md px-3 text-xs font-medium text-destructive hover:bg-destructive/10"
                        >
                          {tc('deactivate')}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Create / Edit Modal */}
      {modalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={e => {
            if (e.target === e.currentTarget) setModalOpen(false);
          }}
        >
          <div className="w-full max-w-lg rounded-xl border border-border bg-card p-6 shadow-xl">
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
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                    placeholder="Main Warehouse"
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
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                    placeholder="المستودع الرئيسي"
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
                    className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
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
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
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
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                    placeholder="29.3759"
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
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                    placeholder="47.9774"
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
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                  placeholder="Shuwaikh Industrial Area, Kuwait"
                />
              </label>

              {/* Is Default */}
              <label className="flex min-h-[44px] items-center gap-3 rounded-md border border-border px-3">
                <input
                  type="checkbox"
                  checked={form.isDefault}
                  onChange={e => setForm(f => ({ ...f, isDefault: e.target.checked }))}
                  className="h-4 w-4 rounded border-input text-primary"
                />
                <span className="text-sm">{t('form.isDefault')}</span>
              </label>
            </div>

            {/* Actions */}
            <div className="mt-6 flex justify-end gap-3">
              <Button
                variant="ghost"
                onClick={() => setModalOpen(false)}
                disabled={saving}
                className="min-h-[44px]"
              >
                {tc('cancel')}
              </Button>
              <Button onClick={handleSave} disabled={saving} className="min-h-[44px]">
                {saving ? tc('saving') : tc('save')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </AdminLayout>
  );
}
