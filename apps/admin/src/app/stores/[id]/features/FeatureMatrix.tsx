'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { Modal, useToast } from '@ebda/ui';
import { Button } from '@/components/ui/Button';
import { useLocale } from 'next-intl';
import { apiGet, apiPut, apiDelete, apiPatch } from '@/lib/api';
import {
  getSuperAdminFeatures,
  publicPlanForStorePlan,
  type StorePlan,
  type FeatureKey,
  type FeatureCategory,
  type FeatureDefinition,
} from '@ebda/shared';
import { ToggleSwitch } from './_components/ToggleSwitch';
import { useT } from '@/i18n/useT';
import { useFeatures } from '@/hooks/useFeatures';
import { SubscriptionPlanRow, useStorePlan } from '@/components/billing/SubscriptionPlanRow';
import { featureTriState, type TriState } from '@/lib/feature-state';

// ─── Types ───────────────────────────────────────────────────────────────────

interface OverrideMetadata {
  featureKey: string;
  enabled: boolean;
  enabledAt: string | null;
  enabledBy: string | null;
  updatedAt: string;
}

interface FeaturesResponse {
  features: Record<string, boolean>;
  metadata: OverrideMetadata[];
  registry: Record<FeatureKey, FeatureDefinition>;
}

interface StoreInfo {
  id: string;
  name: string;
  plan: StorePlan;
  status: 'active' | 'suspended' | string;
}

const CATEGORY_ORDER: FeatureCategory[] = [
  'commerce',
  'marketing',
  'operations',
  'storefront',
  'engagement',
];

import { formatDate } from '@/lib/format';

// ─── Badge ────────────────────────────────────────────────────────────────────

function TriStateBadge({ state, planLabel }: { state: TriState; planLabel: string }) {
  const t = useT('features.matrix');
  const configs: Record<TriState, { color: string; dot: string; label: string }> = {
    baseline_on: {
      color:
        'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-400 dark:border-emerald-800',
      dot: 'bg-emerald-500',
      label: t('badges.includedIn', { plan: planLabel }),
    },
    override_on: {
      color:
        'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/30 dark:text-blue-400 dark:border-blue-800',
      dot: 'bg-blue-500',
      label: t('badges.grantedByOverride'),
    },
    override_off: {
      color: 'bg-warning/10 text-warning-ink border-warning/40',
      dot: 'bg-warning',
      label: t('badges.revokedByOverride'),
    },
    baseline_off: {
      color: 'bg-muted text-muted-ink border-border',
      dot: 'bg-muted-foreground',
      label: t('badges.notIn', { plan: planLabel }),
    },
  };
  const cfg = configs[state];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${cfg.color}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${cfg.dot}`} />
      {cfg.label}
    </span>
  );
}

// ─── Feature Row ──────────────────────────────────────────────────────────────

interface FeatureRowProps {
  def: FeatureDefinition;
  tier: StorePlan;
  planLabel: string;
  effective: Record<string, boolean>;
  overrideRow: OverrideMetadata | undefined;
  inFlight: boolean;
  onAction: (key: FeatureKey, state: TriState) => void;
}

function FeatureRowItem({
  def,
  tier,
  planLabel,
  effective,
  overrideRow,
  inFlight,
  onAction,
}: FeatureRowProps) {
  const tFeatures = useT('features');
  const locale = useLocale() === 'ar' ? 'ar' : 'en';
  const state = featureTriState(tier, def.key, overrideRow, effective);
  const isEffectivelyOn = state === 'baseline_on' || state === 'override_on';

  return (
    <div className="flex items-start justify-between px-6 py-4 hover:bg-muted/30 transition-colors">
      <div className="flex-1 min-w-0 me-4">
        {/* STORE-QA-14: one language per locale. The English + Arabic stack read as a duplicate and leaked internal copy. */}
        <p className="font-medium text-foreground">{locale === 'ar' ? def.nameAr : def.name}</p>
        <p className="text-sm text-muted-foreground leading-snug">
          {locale === 'ar' ? def.descriptionAr : def.description}
        </p>
        <div className="mt-1.5 flex flex-wrap gap-1.5 items-center">
          <TriStateBadge state={state} planLabel={planLabel} />
          {def.hidden && (
            <span className="inline-flex items-center rounded-full border border-border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
              {tFeatures('row.hiddenFromMerchants')}
            </span>
          )}
          {(state === 'override_on' || state === 'override_off') && overrideRow?.enabledBy && (
            <span className="text-xs text-muted-foreground">
              {tFeatures('row.enabledBy')}{' '}
              <span className="font-medium text-foreground">{overrideRow.enabledBy}</span>
              {overrideRow.enabledAt ? ` · ${formatDate(overrideRow.enabledAt)}` : ''}
            </span>
          )}
        </div>
      </div>
      <div className="flex-shrink-0 pt-1">
        <ToggleSwitch
          enabled={isEffectivelyOn}
          onChange={() => onAction(def.key, state)}
          disabled={inFlight}
          label={def.nameAr || def.name}
        />
      </div>
    </div>
  );
}

// ─── Category Section ─────────────────────────────────────────────────────────

interface CategorySectionProps {
  category: FeatureCategory;
  features: FeatureDefinition[];
  tier: StorePlan;
  planLabel: string;
  effective: Record<string, boolean>;
  overrideMap: Map<string, OverrideMetadata>;
  inFlightKeys: Set<string>;
  onAction: (key: FeatureKey, state: TriState) => void;
}

function CategorySection({
  category,
  features,
  tier,
  planLabel,
  effective,
  overrideMap,
  inFlightKeys,
  onAction,
}: CategorySectionProps) {
  const t = useT('features.matrix');
  const tFeatures = useT('features');
  return (
    <div className="bg-card rounded-xl border border-border overflow-hidden">
      <div className="flex items-center justify-between px-6 py-4 border-b border-border bg-muted/40">
        <div>
          <h2 className="font-semibold text-foreground">{tFeatures(`categories.${category}`)}</h2>
          <p className="text-xs text-muted-foreground">
            {t('featureCount', { count: features.length })}
          </p>
        </div>
        <span className="text-xs font-medium text-muted-ink bg-muted rounded-full px-2 py-0.5">
          {features.length}
        </span>
      </div>
      <div className="divide-y divide-border">
        {features.map(def => (
          <FeatureRowItem
            key={def.key}
            def={def}
            tier={tier}
            planLabel={planLabel}
            effective={effective}
            overrideRow={overrideMap.get(def.key)}
            inFlight={inFlightKeys.has(def.key)}
            onAction={onAction}
          />
        ))}
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

interface FeatureMatrixProps {
  storeId: string;
}

export function FeatureMatrix({ storeId }: FeatureMatrixProps) {
  const { success: toastSuccess, error: toastError } = useToast();
  // The store-wide feature context (sidebar, page gates, Settings cards) —
  // refreshed after every write below so a toggle shows up without a reload.
  const { refresh: refreshFeatureContext } = useFeatures();
  const t = useT('features.matrix');
  const tCommon = useT('common');
  const locale = useLocale();
  // ONE plan source: billing's effective plan (name + feature tier). `stores.plan` is a legacy column and disagreed with it.
  const planState = useStorePlan(storeId);

  // Store info (plan + name)
  const [storeInfo, setStoreInfo] = useState<StoreInfo | null>(null);
  const [storeLoading, setStoreLoading] = useState(true);

  // Feature overrides from API
  const [overrideMap, setOverrideMap] = useState<Map<string, OverrideMetadata>>(new Map());
  const [effective, setEffective] = useState<Record<string, boolean>>({});
  const [featuresLoading, setFeaturesLoading] = useState(true);

  // Per-key in-flight set
  const [inFlightKeys, setInFlightKeys] = useState<Set<string>>(new Set());

  // Suspend modal
  const [suspendModalOpen, setSuspendModalOpen] = useState(false);
  const [statusChanging, setStatusChanging] = useState(false);

  // Reset modal
  const [resetModalOpen, setResetModalOpen] = useState(false);
  const [resetting, setResetting] = useState(false);

  // ── Fetch store info ───────────────────────────────────────────────────────
  const fetchStore = useCallback(async () => {
    setStoreLoading(true);
    const { data } = await apiGet<{ store: StoreInfo }>(`/api/v1/admin/stores/${storeId}`);
    if (data?.store) setStoreInfo(data.store);
    setStoreLoading(false);
  }, [storeId]);

  // ── Fetch feature overrides ────────────────────────────────────────────────
  const fetchFeatures = useCallback(async () => {
    setFeaturesLoading(true);
    const { data, error: apiErr } = await apiGet<FeaturesResponse>(
      `/api/v1/admin/stores/${storeId}/features`
    );
    if (apiErr) {
      toastError(t('toasts.loadFeaturesFailed'), apiErr.message);
    } else if (data) {
      setOverrideMap(new Map(data.metadata.map(m => [m.featureKey, m])));
      setEffective(data.features ?? {});
    }
    setFeaturesLoading(false);
  }, [storeId, toastError, t]);

  useEffect(() => {
    fetchStore();
    fetchFeatures();
  }, [fetchStore, fetchFeatures]);

  // ── Toggle action ──────────────────────────────────────────────────────────
  const handleAction = useCallback(
    async (key: FeatureKey, state: TriState) => {
      if (inFlightKeys.has(key)) return;
      setInFlightKeys(prev => new Set(prev).add(key));

      let result: { error: { message: string } | null };
      if (state === 'baseline_on' || state === 'baseline_off') {
        // No override row yet — create one
        const enabled = state === 'baseline_off'; // ON for currently-off, OFF for currently-on
        result = await apiPut(`/api/v1/admin/stores/${storeId}/features/${key}`, { enabled });
      } else {
        // Override row exists — clear it (revert to baseline)
        result = await apiDelete(`/api/v1/admin/stores/${storeId}/features/${key}`);
      }

      if (result.error) {
        toastError(t('toasts.featureUpdateFailed'), result.error.message);
      } else {
        await Promise.all([fetchFeatures(), refreshFeatureContext()]);
      }

      setInFlightKeys(prev => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    },
    [inFlightKeys, storeId, fetchFeatures, refreshFeatureContext, toastError, t]
  );

  // ── Suspend / reactivate ───────────────────────────────────────────────────
  const handleStatusChange = useCallback(async () => {
    if (!storeInfo) return;
    setStatusChanging(true);
    const newStatus = storeInfo.status === 'suspended' ? 'active' : 'suspended';
    const { error: apiErr } = await apiPatch(`/api/v1/stores/${storeId}/status`, {
      status: newStatus,
    });
    if (apiErr) {
      toastError(t('toasts.statusChangeFailed'), apiErr.message);
    } else {
      toastSuccess(
        newStatus === 'suspended' ? t('toasts.storeSuspended') : t('toasts.storeReactivated'),
        t('toasts.storeStatusDescription', {
          name: storeInfo.name,
          status:
            newStatus === 'suspended' ? t('toasts.statusSuspended') : t('toasts.statusActive'),
        })
      );
      await fetchStore();
    }
    setStatusChanging(false);
    setSuspendModalOpen(false);
  }, [storeInfo, storeId, fetchStore, toastSuccess, toastError, t]);

  // ── Reset overrides ────────────────────────────────────────────────────────
  const handleReset = useCallback(async () => {
    setResetting(true);
    const { error: apiErr } = await apiDelete(`/api/v1/admin/stores/${storeId}/features`);
    if (apiErr) {
      toastError(t('toasts.resetFailed'), apiErr.message);
    } else {
      toastSuccess(t('toasts.overridesCleared'), t('toasts.overridesClearedDescription'));
      await Promise.all([fetchFeatures(), refreshFeatureContext()]);
    }
    setResetting(false);
    setResetModalOpen(false);
  }, [storeId, fetchFeatures, refreshFeatureContext, toastSuccess, toastError, t]);

  // ── Render ─────────────────────────────────────────────────────────────────

  const isLoading = storeLoading || featuresLoading;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  if (!storeInfo) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        {t('loadStoreFailed')}{' '}
        <button type="button" onClick={fetchStore} className="underline">
          {tCommon('retry')}
        </button>
      </div>
    );
  }

  // Group visible features by category
  const visibleFeatures = getSuperAdminFeatures();
  const grouped: Record<FeatureCategory, FeatureDefinition[]> = {
    commerce: [],
    marketing: [],
    operations: [],
    storefront: [],
    engagement: [],
  };
  for (const def of visibleFeatures) {
    grouped[def.category].push(def);
  }

  const tier = (planState.plan?.featureTier ?? storeInfo.plan) as StorePlan;
  const planName = planState.plan
    ? locale === 'ar'
      ? planState.plan.nameAr
      : planState.plan.nameEn
    : ((l: 'ar' | 'en') => {
        const sold = publicPlanForStorePlan(storeInfo.plan);
        return sold ? sold[l] : storeInfo.plan;
      })(locale === 'ar' ? 'ar' : 'en');
  const isSuspended = storeInfo.status === 'suspended';

  return (
    <div className="space-y-8">
      {/* ── Plan: the subscription's priced plan + the one place to assign it (Ruling B1-PLAN-SOT-1) ── */}
      <div className="space-y-2">
        <SubscriptionPlanRow storeId={storeId} state={planState} />
        <p className="text-xs text-muted-foreground">{t('baselineTierNote', { plan: planName })}</p>
      </div>

      {/* ── Feature Matrix ───────────────────────────────────────────────────── */}
      <div className="space-y-6">
        {CATEGORY_ORDER.map(category => {
          const features = grouped[category];
          if (features.length === 0) return null;
          return (
            <CategorySection
              key={category}
              category={category}
              features={features}
              tier={tier}
              planLabel={planName}
              effective={effective}
              overrideMap={overrideMap}
              inFlightKeys={inFlightKeys}
              onAction={handleAction}
            />
          );
        })}
      </div>

      {/* ── Danger Zone ──────────────────────────────────────────────────────── */}
      <div className="mt-8">
        <h2 className="mb-4 font-semibold text-destructive-ink">{t('dangerZone.heading')}</h2>
        <div className="rounded-xl border-2 border-destructive/40 bg-destructive/5 p-6 space-y-4">
          {/* Suspend / Reactivate */}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-sm font-medium text-foreground">
                {isSuspended ? t('dangerZone.reactivateTitle') : t('dangerZone.suspendTitle')}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {isSuspended
                  ? t('dangerZone.reactivateDescription')
                  : t('dangerZone.suspendDescription')}
              </p>
            </div>
            <div className="shrink-0">
              <Button
                variant={isSuspended ? 'default' : 'destructive'}
                onClick={() => setSuspendModalOpen(true)}
                disabled={statusChanging}
              >
                {isSuspended ? t('dangerZone.reactivateTitle') : t('dangerZone.suspendTitle')}
              </Button>
            </div>
          </div>

          <div className="border-t border-destructive/20" />

          {/* Reset overrides */}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-sm font-medium text-foreground">{t('dangerZone.resetTitle')}</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {t('dangerZone.resetDescription')}
              </p>
            </div>
            <div className="shrink-0">
              <Button
                variant="destructive"
                onClick={() => setResetModalOpen(true)}
                disabled={resetting}
              >
                {t('dangerZone.resetButton')}
              </Button>
            </div>
          </div>

          {/* Audit log link */}
          <div className="border-t border-destructive/20 pt-3">
            <Link href="/audit-logs" className="text-sm text-primary hover:underline">
              {t('dangerZone.auditLogsLink')}
            </Link>
          </div>
        </div>
      </div>

      {/* ── Modals ───────────────────────────────────────────────────────────── */}

      {/* Suspend / reactivate confirm */}
      <Modal
        isOpen={suspendModalOpen}
        onClose={() => setSuspendModalOpen(false)}
        title={isSuspended ? t('dangerZone.reactivateTitle') : t('dangerZone.suspendTitle')}
        size="sm"
      >
        <p className="text-sm text-muted-foreground">
          {isSuspended
            ? t('modals.reactivateBody', { name: storeInfo.name })
            : t('modals.suspendBody', { name: storeInfo.name })}
        </p>
        <div className="mt-6 flex justify-end gap-3">
          <Button
            variant="outline"
            onClick={() => setSuspendModalOpen(false)}
            disabled={statusChanging}
          >
            {tCommon('cancel')}
          </Button>
          <Button
            variant={isSuspended ? 'default' : 'destructive'}
            onClick={handleStatusChange}
            disabled={statusChanging}
            isLoading={statusChanging}
          >
            {isSuspended ? t('modals.confirmReactivate') : t('modals.confirmSuspend')}
          </Button>
        </div>
      </Modal>

      {/* Reset confirm */}
      <Modal
        isOpen={resetModalOpen}
        onClose={() => setResetModalOpen(false)}
        title={t('dangerZone.resetTitle')}
        size="sm"
      >
        <p className="text-sm text-muted-foreground">
          {t.rich('modals.resetBody', {
            b: chunks => <strong>{chunks}</strong>,
            plan: planName,
          })}
        </p>
        <div className="mt-6 flex justify-end gap-3">
          <Button variant="outline" onClick={() => setResetModalOpen(false)} disabled={resetting}>
            {tCommon('cancel')}
          </Button>
          <Button
            variant="destructive"
            onClick={handleReset}
            disabled={resetting}
            isLoading={resetting}
          >
            {t('modals.resetAllButton')}
          </Button>
        </div>
      </Modal>
    </div>
  );
}
