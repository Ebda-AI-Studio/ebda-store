'use client';

/**
 * Super-admin Plans — /plans (SP5 task 1).
 *
 * `plans` is DATA: this page lists every plan (including the non-public
 * `comped` grant) and edits its names, order, visibility, prices and limits.
 * Prices are piastres in the DB and NULL until Ahmad sets them ("Not set" is
 * shown, never 0). A null numeric limit means unlimited.
 *
 * Route guard: super_admin only (RequireSuperAdmin + the API's requireRole).
 */

import { useCallback, useEffect, useState } from 'react';
import { useLocale } from 'next-intl';
import { Badge, Input, Modal, ModalBody, ModalFooter, useToast } from '@ebda/ui';
import { Button } from '@/components/ui/Button';
import { formatMoney, type PlanLimits, withNumerals } from '@ebda/shared';
import { AdminLayout } from '../../components/AdminLayout';
import { RequireSuperAdmin } from '../../components/RequireSuperAdmin';
import { Toggle } from '../../components/Toggle';
import { DataTable, type DataTableColumn } from '../../components/mobile/DataTable';
import { apiGet, apiPut } from '../../lib/api';
import { useT } from '../../i18n/useT';
import { FIELD_CLASSES } from '@/components/ui/tokens';

interface PlanRow {
  code: string;
  nameEn: string;
  nameAr: string;
  sort: number;
  isPublic: boolean;
  priceMonthlyMinor: number | null;
  priceYearlyMinor: number | null;
  featureTier: string;
  limits: PlanLimits;
  subscriberCount?: number;
}

const NUMERIC_KEYS = [
  'maxProducts',
  'maxStaff',
  'maxOrdersPerMonth',
  'maxStorageMb',
  'maxStores',
] as const;
const BOOLEAN_KEYS = [
  'customDomain',
  'abandonedCartAutomation',
  'whatsappAutomation',
  'brandingRemoval',
  'apiAccess',
  'wholesalePricing',
] as const;
const TIER_KEYS = [
  { key: 'analyticsTier', options: ['basic', 'standard', 'advanced'] },
  { key: 'supportTier', options: ['email', 'chat', 'priority'] },
] as const;
const BPS_KEYS = ['platformFeeBps', 'codPlatformFeeBps'] as const;

/** Piastres -> the EGP string in an input ('' = not set). */
function minorToInput(minor: number | null): string {
  return minor === null ? '' : (minor / 100).toFixed(2);
}

/** The EGP string in an input -> piastres (null when blank, NaN when invalid). */
function inputToMinor(value: string): number | null {
  const v = value.trim();
  if (v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : Number.NaN;
}

function PlansInner() {
  const t = useT('plans');
  const tCommon = useT('common');
  const locale = useLocale() === 'ar' ? 'ar' : 'en';
  const { success: toastSuccess, error: toastError } = useToast();

  const [plans, setPlans] = useState<PlanRow[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [editing, setEditing] = useState<PlanRow | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Edit-form state (strings for inputs; converted on save).
  const [form, setForm] = useState({
    nameEn: '',
    nameAr: '',
    sort: '0',
    isPublic: true,
    priceMonthly: '',
    priceYearly: '',
  });
  const [limits, setLimits] = useState<PlanLimits | null>(null);

  const load = useCallback(async () => {
    setLoadError(false);
    const { data, error } = await apiGet<{ plans: PlanRow[] }>('/api/v1/admin/plans');
    if (error || !data) {
      setLoadError(true);
      return;
    }
    setPlans(data.plans);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function openEdit(plan: PlanRow) {
    setEditing(plan);
    setFormError(null);
    setForm({
      nameEn: plan.nameEn,
      nameAr: plan.nameAr,
      sort: String(plan.sort),
      isPublic: plan.isPublic,
      priceMonthly: minorToInput(plan.priceMonthlyMinor),
      priceYearly: minorToInput(plan.priceYearlyMinor),
    });
    setLimits({ ...plan.limits });
  }

  async function save() {
    if (!editing || !limits) return;
    const monthly = inputToMinor(form.priceMonthly);
    const yearly = inputToMinor(form.priceYearly);
    const sort = Number.parseInt(form.sort, 10);
    if (Number.isNaN(monthly) || Number.isNaN(yearly) || Number.isNaN(sort)) {
      setFormError(t('errors.invalidNumber'));
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const { error } = await apiPut(`/api/v1/admin/plans/${editing.code}`, {
        nameEn: form.nameEn,
        nameAr: form.nameAr,
        sort,
        isPublic: form.isPublic,
        priceMonthlyMinor: monthly,
        priceYearlyMinor: yearly,
        limits,
      });
      if (error) {
        setFormError(error.message || t('errors.saveFailed'));
        return;
      }
      toastSuccess(t('toasts.savedTitle'), t('toasts.savedDesc', { code: editing.code }));
      setEditing(null);
      await load();
    } catch {
      toastError(t('toasts.errorTitle'), t('errors.saveFailed'));
    } finally {
      setSaving(false);
    }
  }

  function limitLabel(v: number | null): string {
    return v === null
      ? t('unlimited')
      : v.toLocaleString(locale === 'ar' ? 'ar-EG-u-nu-latn' : 'en', withNumerals());
  }

  function priceLabel(minor: number | null): string {
    return minor === null ? t('priceNotSet') : formatMoney(minor, locale, { fixedDecimals: true });
  }

  if (loadError) {
    return (
      <div className="rounded-xl border bg-card p-6 text-center">
        <p className="text-sm text-destructive-ink">{t('loadError')}</p>
        <Button variant="link" size="sm" type="button" onClick={load} className="mt-3">
          {tCommon('retry')}
        </Button>
      </div>
    );
  }
  if (!plans) return <p className="text-sm text-muted-foreground">{t('loading')}</p>;

  const columns: DataTableColumn<PlanRow>[] = [
    {
      header: t('table.plan'),
      primaryOnMobile: true,
      cell: p => (
        <div>
          <div className="font-medium text-foreground">{locale === 'ar' ? p.nameAr : p.nameEn}</div>
          <div className="text-xs text-muted-foreground">
            {p.code} · {p.featureTier}
          </div>
        </div>
      ),
    },
    {
      header: t('table.visibility'),
      mobileBadge: true,
      cell: p => (
        <Badge variant={p.isPublic ? 'success' : 'secondary'}>
          {p.isPublic ? t('public') : t('hidden')}
        </Badge>
      ),
    },
    {
      header: t('table.monthly'),
      alignEnd: true,
      cell: p => <span className="tabular-nums">{priceLabel(p.priceMonthlyMinor)}</span>,
    },
    {
      header: t('table.yearly'),
      alignEnd: true,
      hideOnMobile: true,
      cell: p => <span className="tabular-nums">{priceLabel(p.priceYearlyMinor)}</span>,
    },
    {
      header: t('limits.maxProducts'),
      alignEnd: true,
      hideOnMobile: true,
      cell: p => <span className="tabular-nums">{limitLabel(p.limits.maxProducts)}</span>,
    },
    {
      header: t('limits.maxStaff'),
      alignEnd: true,
      hideOnMobile: true,
      cell: p => <span className="tabular-nums">{limitLabel(p.limits.maxStaff)}</span>,
    },
    {
      header: t('limits.maxOrdersPerMonth'),
      alignEnd: true,
      cell: p => <span className="tabular-nums">{limitLabel(p.limits.maxOrdersPerMonth)}</span>,
    },
    {
      header: t('table.stores'),
      alignEnd: true,
      cell: p => (
        <span className="tabular-nums">
          {(p.subscriberCount ?? 0).toLocaleString(undefined, withNumerals())}
        </span>
      ),
    },
    {
      header: t('table.actions'),
      alignEnd: true,
      mobileActions: true,
      cell: p => (
        <Button
          variant="outline"
          size="sm"
          className="max-md:min-h-11 max-md:px-4"
          onClick={() => openEdit(p)}
        >
          {t('edit')}
        </Button>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">{t('priceHint')}</p>
      <div className="rounded-xl border bg-card shadow-sm">
        <DataTable<PlanRow>
          ariaLabel={t('title')}
          columns={columns}
          rows={plans}
          rowKey={p => p.code}
        />
      </div>

      <Modal
        isOpen={editing !== null}
        onClose={() => setEditing(null)}
        title={editing ? t('editTitle', { code: editing.code }) : ''}
        size="lg"
      >
        <ModalBody>
          {limits && (
            <div className="space-y-5">
              <div className="grid gap-3 sm:grid-cols-2">
                <Input
                  label={t('form.nameEn')}
                  value={form.nameEn}
                  onChange={e => setForm(f => ({ ...f, nameEn: e.target.value }))}
                />
                <Input
                  label={t('form.nameAr')}
                  dir="rtl"
                  value={form.nameAr}
                  onChange={e => setForm(f => ({ ...f, nameAr: e.target.value }))}
                />
                <Input
                  label={t('form.sort')}
                  type="number"
                  min={0}
                  value={form.sort}
                  onChange={e => setForm(f => ({ ...f, sort: e.target.value }))}
                />
                <div className="flex items-end gap-3 pb-2">
                  <Toggle
                    checked={form.isPublic}
                    onChange={v => setForm(f => ({ ...f, isPublic: v }))}
                    label={t('form.isPublic')}
                  />
                  <span className="text-sm">{t('form.isPublic')}</span>
                </div>
                <Input
                  label={t('form.priceMonthly')}
                  type="number"
                  min={0}
                  step="0.01"
                  inputMode="decimal"
                  placeholder={t('priceNotSet')}
                  value={form.priceMonthly}
                  onChange={e => setForm(f => ({ ...f, priceMonthly: e.target.value }))}
                />
                <Input
                  label={t('form.priceYearly')}
                  type="number"
                  min={0}
                  step="0.01"
                  inputMode="decimal"
                  placeholder={t('priceNotSet')}
                  value={form.priceYearly}
                  onChange={e => setForm(f => ({ ...f, priceYearly: e.target.value }))}
                />
              </div>

              <div>
                <h3 className="mb-2 text-sm font-semibold">{t('form.limitsTitle')}</h3>
                <div className="grid gap-3 sm:grid-cols-2">
                  {NUMERIC_KEYS.map(k => (
                    <div key={k} className="space-y-1">
                      <Input
                        label={t(`limits.${k}`)}
                        type="number"
                        min={0}
                        disabled={limits[k] === null}
                        value={limits[k] === null ? '' : String(limits[k])}
                        placeholder={limits[k] === null ? t('unlimited') : undefined}
                        onChange={e => {
                          const n = Number.parseInt(e.target.value, 10);
                          setLimits(l => (l ? { ...l, [k]: Number.isNaN(n) ? 0 : n } : l));
                        }}
                      />
                      <label className="flex items-center gap-2 text-xs text-muted-foreground">
                        <input
                          type="checkbox"
                          checked={limits[k] === null}
                          onChange={e =>
                            setLimits(l => (l ? { ...l, [k]: e.target.checked ? null : 0 } : l))
                          }
                        />
                        {t('unlimited')}
                      </label>
                    </div>
                  ))}
                  {BPS_KEYS.map(k => (
                    <Input
                      key={k}
                      label={t(`limits.${k}`)}
                      type="number"
                      min={0}
                      max={10000}
                      value={String(limits[k])}
                      onChange={e => {
                        const n = Number.parseInt(e.target.value, 10);
                        setLimits(l => (l ? { ...l, [k]: Number.isNaN(n) ? 0 : n } : l));
                      }}
                    />
                  ))}
                </div>
                <div className="mt-3 space-y-2">
                  {BOOLEAN_KEYS.map(k => (
                    <div key={k} className="flex items-center gap-3">
                      <Toggle
                        checked={limits[k]}
                        onChange={v => setLimits(l => (l ? { ...l, [k]: v } : l))}
                        label={t(`limits.${k}`)}
                      />
                      <span className="text-sm">{t(`limits.${k}`)}</span>
                    </div>
                  ))}
                </div>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  {TIER_KEYS.map(({ key, options }) => (
                    <label key={key} className="space-y-1 text-sm">
                      <span>{t(`limits.${key}`)}</span>
                      <select
                        className={`${FIELD_CLASSES} block`}
                        value={limits[key]}
                        onChange={e => setLimits(l => (l ? { ...l, [key]: e.target.value } : l))}
                      >
                        {options.map(o => (
                          <option key={o} value={o}>
                            {t(`tiers.${o}`)}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                </div>
                <p className="mt-2 text-xs text-muted-foreground">{t('form.bpsHint')}</p>
              </div>

              {formError && <p className="text-sm text-destructive-ink">{formError}</p>}
            </div>
          )}
        </ModalBody>
        <ModalFooter>
          <Button variant="outline" onClick={() => setEditing(null)} disabled={saving}>
            {tCommon('cancel')}
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving ? t('saving') : t('save')}
          </Button>
        </ModalFooter>
      </Modal>
    </div>
  );
}

export default function PlansPage() {
  const t = useT('plans');
  return (
    <AdminLayout title={t('title')} subtitle={t('subtitle')} mode="super_admin">
      <RequireSuperAdmin>
        <PlansInner />
      </RequireSuperAdmin>
    </AdminLayout>
  );
}
