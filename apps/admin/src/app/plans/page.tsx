'use client';

/**
 * Super-admin Plans — /plans (SP5 task 1).
 *
 * `plans` is DATA: this page lists every plan (including the non-public
 * `comped` grant) and edits its names, order, visibility, prices and limits.
 * Prices are piastres in the DB and NULL until Ahmad sets them ("Not set" is
 * shown, never 0). A null price means "no price for that period yet": the
 * marketing page shows "price soon", onboarding shows "price TBD" and
 * subscribing raises PLAN_PRICE_NOT_SET. A null numeric limit means unlimited.
 * Fees are edited as percentages and sent as bps (API contract unchanged).
 *
 * Route guard: super_admin only (RequireSuperAdmin + the API's requireRole).
 */

import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from 'react';
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
import { bpsToPercentInput, percentInputToBps } from './plan-form';

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
type FeeKey = (typeof BPS_KEYS)[number];

interface FormState {
  nameEn: string;
  nameAr: string;
  sort: string;
  isPublic: boolean;
  priceMonthly: string;
  priceYearly: string;
}

/** Form state -> API payload; null while any field is invalid. */
function buildPayload(form: FormState, fees: Record<FeeKey, string>, limits: PlanLimits) {
  const monthly = inputToMinor(form.priceMonthly);
  const yearly = inputToMinor(form.priceYearly);
  const sort = Number.parseInt(form.sort, 10);
  const platformFeeBps = percentInputToBps(fees.platformFeeBps);
  const codPlatformFeeBps = percentInputToBps(fees.codPlatformFeeBps);
  if ([monthly, yearly, sort, platformFeeBps, codPlatformFeeBps].some(n => Number.isNaN(n))) {
    return null;
  }
  if (!form.nameEn.trim() || !form.nameAr.trim() || sort < 0) return null;
  return {
    nameEn: form.nameEn,
    nameAr: form.nameAr,
    sort,
    isPublic: form.isPublic,
    priceMonthlyMinor: monthly,
    priceYearlyMinor: yearly,
    limits: { ...limits, platformFeeBps, codPlatformFeeBps },
  };
}

/** Input with a fixed unit (EGP / %) inside the field, logical-end aligned for RTL. */
function UnitField({
  label,
  unit,
  help,
  error,
  ...props
}: {
  label: string;
  unit: string;
  help?: string;
  error?: string;
} & React.InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  const noteId = `${id}-note`;
  return (
    <div className="w-full">
      <label htmlFor={id} className="mb-2 block text-sm font-medium text-foreground">
        {label}
      </label>
      <div className="relative">
        <Input
          id={id}
          className="pe-14 tabular-nums"
          data-error={error ? 'true' : undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={help || error ? noteId : undefined}
          {...props}
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 end-3 flex items-center text-sm text-muted-foreground"
        >
          {unit}
        </span>
      </div>
      {(error || help) && (
        <p
          id={noteId}
          className={`mt-1.5 text-sm ${error ? 'text-destructive-ink' : 'text-muted-foreground'}`}
        >
          {error || help}
        </p>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="space-y-3">
      <h3 id={id} className="border-b pb-1.5 text-sm font-semibold text-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

/** Label + help on the start side, switch on the end side. */
function SwitchRow({
  label,
  help,
  checked,
  onChange,
}: {
  label: string;
  help?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border bg-card px-3 py-2.5">
      <span className="min-w-0">
        <span id={`${id}-l`} className="block text-sm text-foreground">
          {label}
        </span>
        {help && (
          <span id={`${id}-h`} className="block text-xs text-muted-foreground">
            {help}
          </span>
        )}
      </span>
      <Toggle
        checked={checked}
        onChange={onChange}
        aria-labelledby={`${id}-l`}
        aria-describedby={help ? `${id}-h` : undefined}
      />
    </div>
  );
}

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
  const [form, setForm] = useState<FormState>({
    nameEn: '',
    nameAr: '',
    sort: '0',
    isPublic: true,
    priceMonthly: '',
    priceYearly: '',
  });
  const [limits, setLimits] = useState<PlanLimits | null>(null);
  const [fees, setFees] = useState<Record<FeeKey, string>>({
    platformFeeBps: '0',
    codPlatformFeeBps: '0',
  });
  const [baseline, setBaseline] = useState('');

  const payload = useMemo(
    () => (limits ? buildPayload(form, fees, limits) : null),
    [form, fees, limits]
  );
  const dirty = payload !== null && JSON.stringify(payload) !== baseline;

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
    const nextFees = {
      platformFeeBps: bpsToPercentInput(plan.limits.platformFeeBps),
      codPlatformFeeBps: bpsToPercentInput(plan.limits.codPlatformFeeBps),
    };
    setFees(nextFees);
    const first = buildPayload(
      {
        nameEn: plan.nameEn,
        nameAr: plan.nameAr,
        sort: String(plan.sort),
        isPublic: plan.isPublic,
        priceMonthly: minorToInput(plan.priceMonthlyMinor),
        priceYearly: minorToInput(plan.priceYearlyMinor),
      },
      nextFees,
      plan.limits
    );
    setBaseline(JSON.stringify(first));
  }

  async function save() {
    if (!editing || !payload) {
      setFormError(t('errors.invalidNumber'));
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const { error } = await apiPut(`/api/v1/admin/plans/${editing.code}`, payload);
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
      <div className="rounded-md border bg-card p-6 text-center">
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
      <p className="text-sm text-muted-foreground">{t('priceHint')}</p>
      <div className="rounded-md border bg-card shadow-sm">
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
        closeLabel={t('form.close')}
        size="lg"
      >
        <ModalBody className="space-y-6 px-0 py-0">
          {limits && (
            <>
              <Section title={t('form.sectionVisibility')}>
                <div className="grid gap-4 sm:grid-cols-2">
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
                  <div className="self-end">
                    <SwitchRow
                      label={t('form.isPublic')}
                      help={t('form.isPublicHelp')}
                      checked={form.isPublic}
                      onChange={v => setForm(f => ({ ...f, isPublic: v }))}
                    />
                  </div>
                </div>
              </Section>

              <Section title={t('form.sectionPrices')}>
                <div className="grid gap-4 sm:grid-cols-2">
                  <UnitField
                    label={t('form.priceMonthly')}
                    unit={t('form.currency')}
                    help={t('form.priceMonthlyHelp')}
                    error={
                      Number.isNaN(inputToMinor(form.priceMonthly))
                        ? t('errors.invalidNumber')
                        : undefined
                    }
                    type="number"
                    min={0}
                    step="0.01"
                    inputMode="decimal"
                    placeholder={t('priceNotSet')}
                    value={form.priceMonthly}
                    onChange={e => setForm(f => ({ ...f, priceMonthly: e.target.value }))}
                  />
                  <UnitField
                    label={t('form.priceYearly')}
                    unit={t('form.currency')}
                    help={t('form.priceYearlyHelp')}
                    error={
                      Number.isNaN(inputToMinor(form.priceYearly))
                        ? t('errors.invalidNumber')
                        : undefined
                    }
                    type="number"
                    min={0}
                    step="0.01"
                    inputMode="decimal"
                    placeholder={t('priceNotSet')}
                    value={form.priceYearly}
                    onChange={e => setForm(f => ({ ...f, priceYearly: e.target.value }))}
                  />
                </div>
              </Section>

              <Section title={t('form.sectionLimits')}>
                <div className="grid gap-4 sm:grid-cols-2">
                  {NUMERIC_KEYS.map(k => (
                    <div key={k} className="space-y-1.5">
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
                      <label className="flex min-h-6 items-center gap-2 text-sm text-muted-foreground">
                        <input
                          type="checkbox"
                          className="h-5 w-5 accent-primary"
                          aria-label={`${t(`limits.${k}`)}: ${t('unlimited')}`}
                          checked={limits[k] === null}
                          onChange={e =>
                            setLimits(l => (l ? { ...l, [k]: e.target.checked ? null : 0 } : l))
                          }
                        />
                        {t('unlimited')}
                      </label>
                    </div>
                  ))}
                </div>
              </Section>

              <Section title={t('form.sectionFees')}>
                <div className="grid gap-4 sm:grid-cols-2">
                  {BPS_KEYS.map(k => (
                    <UnitField
                      key={k}
                      label={t(`limits.${k}`)}
                      unit="%"
                      error={
                        Number.isNaN(percentInputToBps(fees[k])) ? t('form.invalidFee') : undefined
                      }
                      type="text"
                      inputMode="decimal"
                      dir="ltr"
                      value={fees[k]}
                      onChange={e => setFees(f => ({ ...f, [k]: e.target.value }))}
                    />
                  ))}
                </div>
                <p className="text-sm text-muted-foreground">{t('form.feesHelp')}</p>
              </Section>

              <Section title={t('form.sectionFeatures')}>
                <div className="grid gap-2 sm:grid-cols-2">
                  {BOOLEAN_KEYS.map(k => (
                    <SwitchRow
                      key={k}
                      label={t(`limits.${k}`)}
                      checked={limits[k]}
                      onChange={v => setLimits(l => (l ? { ...l, [k]: v } : l))}
                    />
                  ))}
                </div>
              </Section>

              <Section title={t('form.sectionTiers')}>
                <div className="grid gap-4 sm:grid-cols-2">
                  {TIER_KEYS.map(({ key, options }) => (
                    <label key={key} className="block space-y-2 text-sm font-medium">
                      <span>{t(`limits.${key}`)}</span>
                      <select
                        className="block h-11 w-full rounded-md border border-input bg-background px-3 text-base font-normal sm:h-10 sm:text-sm"
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
              </Section>

              {formError && (
                <p role="alert" className="text-sm text-destructive-ink">
                  {formError}
                </p>
              )}
            </>
          )}
        </ModalBody>
        <ModalFooter>
          <Button variant="outline" onClick={() => setEditing(null)} disabled={saving}>
            {tCommon('cancel')}
          </Button>
          <Button onClick={save} disabled={saving || !dirty}>
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
