'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { Button, Modal, useToast } from '@force/ui';
import { apiGet, apiPut, apiDelete, apiPatch } from '@/lib/api';
import {
  PLAN_LABELS,
  STORE_PLANS,
  isInBaseline,
  getVisibleFeatures,
  type StorePlan,
  type FeatureKey,
  type FeatureCategory,
  type FeatureDefinition,
} from '@force/shared';
import { ToggleSwitch } from './_components/ToggleSwitch';

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

type TriState = 'baseline_on' | 'override_on' | 'override_off' | 'baseline_off';

function triState(
  plan: StorePlan,
  key: FeatureKey,
  overrideRow: OverrideMetadata | undefined
): TriState {
  const inBaseline = isInBaseline(plan, key);
  if (overrideRow !== undefined) {
    if (overrideRow.enabled) {
      // Row exists and is enabled
      return inBaseline ? 'baseline_on' : 'override_on';
    } else {
      // Row exists and is disabled
      return inBaseline ? 'override_off' : 'baseline_off';
    }
  }
  // No override row
  return inBaseline ? 'baseline_on' : 'baseline_off';
}

const CATEGORY_ORDER: FeatureCategory[] = [
  'commerce',
  'marketing',
  'operations',
  'storefront',
  'engagement',
];

const CATEGORY_LABELS: Record<FeatureCategory, { en: string; ar: string }> = {
  commerce: { en: 'Commerce', ar: 'التجارة' },
  marketing: { en: 'Marketing', ar: 'التسويق' },
  operations: { en: 'Operations', ar: 'العمليات' },
  storefront: { en: 'Storefront', ar: 'الواجهة' },
  engagement: { en: 'Engagement', ar: 'التفاعل' },
};

import { formatDate } from '@/lib/format';

// ─── Badge ────────────────────────────────────────────────────────────────────

function TriStateBadge({ state, plan }: { state: TriState; plan: StorePlan }) {
  const planLabel = PLAN_LABELS[plan].en;
  const configs: Record<TriState, { color: string; dot: string; label: string }> = {
    baseline_on: {
      color:
        'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-400 dark:border-emerald-800',
      dot: 'bg-emerald-500',
      label: `Included in ${planLabel}`,
    },
    override_on: {
      color:
        'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/30 dark:text-blue-400 dark:border-blue-800',
      dot: 'bg-blue-500',
      label: 'Granted by override',
    },
    override_off: {
      color:
        'bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-950/30 dark:text-orange-400 dark:border-orange-800',
      dot: 'bg-orange-500',
      label: 'Revoked by override',
    },
    baseline_off: {
      color:
        'bg-gray-100 text-gray-500 border-gray-200 dark:bg-gray-800 dark:text-gray-400 dark:border-gray-700',
      dot: 'bg-gray-400',
      label: `Not in ${planLabel}`,
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
  plan: StorePlan;
  overrideRow: OverrideMetadata | undefined;
  inFlight: boolean;
  onAction: (key: FeatureKey, state: TriState) => void;
}

function FeatureRowItem({ def, plan, overrideRow, inFlight, onAction }: FeatureRowProps) {
  const state = triState(plan, def.key, overrideRow);
  const isEffectivelyOn = state === 'baseline_on' || state === 'override_on';

  return (
    <div className="flex items-start justify-between px-6 py-4 hover:bg-muted/30 transition-colors">
      <div className="flex-1 min-w-0 me-4">
        <div className="flex flex-wrap items-center gap-2 mb-0.5">
          <p className="font-medium text-foreground">{def.name}</p>
          <span className="text-muted-foreground text-xs">·</span>
          <p className="text-xs text-muted-foreground" dir="rtl">
            {def.nameAr}
          </p>
        </div>
        <p className="text-sm text-muted-foreground leading-snug">{def.description}</p>
        <p className="text-xs text-muted-foreground leading-snug mt-0.5" dir="rtl">
          {def.descriptionAr}
        </p>
        <div className="mt-1.5 flex flex-wrap gap-1.5 items-center">
          <TriStateBadge state={state} plan={plan} />
          {(state === 'override_on' || state === 'override_off') && overrideRow?.enabledBy && (
            <span className="text-xs text-muted-foreground">
              by <span className="font-medium text-foreground">{overrideRow.enabledBy}</span>
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
        />
      </div>
    </div>
  );
}

// ─── Category Section ─────────────────────────────────────────────────────────

interface CategorySectionProps {
  category: FeatureCategory;
  features: FeatureDefinition[];
  plan: StorePlan;
  overrideMap: Map<string, OverrideMetadata>;
  inFlightKeys: Set<string>;
  onAction: (key: FeatureKey, state: TriState) => void;
}

function CategorySection({
  category,
  features,
  plan,
  overrideMap,
  inFlightKeys,
  onAction,
}: CategorySectionProps) {
  const label = CATEGORY_LABELS[category];
  return (
    <div className="bg-card rounded-xl border border-border overflow-hidden">
      <div className="flex items-center justify-between px-6 py-4 border-b border-border bg-muted/40">
        <div>
          <h2 className="font-semibold text-foreground">{label.en}</h2>
          <p className="text-xs text-muted-foreground" dir="rtl">
            {label.ar} · {features.length} features
          </p>
        </div>
        <span className="text-xs font-medium text-muted-foreground bg-muted rounded-full px-2 py-0.5">
          {features.length}
        </span>
      </div>
      <div className="divide-y divide-border">
        {features.map(def => (
          <FeatureRowItem
            key={def.key}
            def={def}
            plan={plan}
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

  // Store info (plan + name)
  const [storeInfo, setStoreInfo] = useState<StoreInfo | null>(null);
  const [storeLoading, setStoreLoading] = useState(true);

  // Feature overrides from API
  const [overrideMap, setOverrideMap] = useState<Map<string, OverrideMetadata>>(new Map());
  const [featuresLoading, setFeaturesLoading] = useState(true);

  // Per-key in-flight set
  const [inFlightKeys, setInFlightKeys] = useState<Set<string>>(new Set());

  // Plan change modal
  const [planModalOpen, setPlanModalOpen] = useState(false);
  const [pendingPlan, setPendingPlan] = useState<StorePlan | null>(null);
  const [planChanging, setPlanChanging] = useState(false);

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
      toastError('Failed to load features', apiErr.message);
    } else if (data) {
      setOverrideMap(new Map(data.metadata.map(m => [m.featureKey, m])));
    }
    setFeaturesLoading(false);
  }, [storeId, toastError]);

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
        toastError('Feature update failed', result.error.message);
      } else {
        await fetchFeatures();
      }

      setInFlightKeys(prev => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    },
    [inFlightKeys, storeId, fetchFeatures, toastError]
  );

  // ── Plan change ────────────────────────────────────────────────────────────
  const handlePlanChange = useCallback(async () => {
    if (!pendingPlan) return;
    setPlanChanging(true);
    const { error: apiErr } = await apiPut(`/api/v1/admin/stores/${storeId}/plan`, {
      plan: pendingPlan,
    });
    if (apiErr) {
      toastError('Plan change failed', apiErr.message);
    } else {
      toastSuccess('Plan updated', `Store plan changed to ${PLAN_LABELS[pendingPlan].en}.`);
      await fetchStore();
    }
    setPlanChanging(false);
    setPlanModalOpen(false);
    setPendingPlan(null);
  }, [pendingPlan, storeId, fetchStore, toastSuccess, toastError]);

  // ── Suspend / reactivate ───────────────────────────────────────────────────
  const handleStatusChange = useCallback(async () => {
    if (!storeInfo) return;
    setStatusChanging(true);
    const newStatus = storeInfo.status === 'suspended' ? 'active' : 'suspended';
    const { error: apiErr } = await apiPatch(`/api/v1/stores/${storeId}/status`, {
      status: newStatus,
    });
    if (apiErr) {
      toastError('Status change failed', apiErr.message);
    } else {
      toastSuccess(
        newStatus === 'suspended' ? 'Store suspended' : 'Store reactivated',
        `${storeInfo.name} is now ${newStatus}.`
      );
      await fetchStore();
    }
    setStatusChanging(false);
    setSuspendModalOpen(false);
  }, [storeInfo, storeId, fetchStore, toastSuccess, toastError]);

  // ── Reset overrides ────────────────────────────────────────────────────────
  const handleReset = useCallback(async () => {
    setResetting(true);
    const { error: apiErr } = await apiDelete(`/api/v1/admin/stores/${storeId}/features`);
    if (apiErr) {
      toastError('Reset failed', apiErr.message);
    } else {
      toastSuccess('Overrides cleared', 'Store is now using plan defaults.');
      await fetchFeatures();
    }
    setResetting(false);
    setResetModalOpen(false);
  }, [storeId, fetchFeatures, toastSuccess, toastError]);

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
        Failed to load store.{' '}
        <button type="button" onClick={fetchStore} className="underline">
          Retry
        </button>
      </div>
    );
  }

  // Group visible features by category
  const visibleFeatures = getVisibleFeatures();
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

  const plan = storeInfo.plan as StorePlan;
  const isSuspended = storeInfo.status === 'suspended';

  return (
    <div className="space-y-8">
      {/* ── Plan Picker ─────────────────────────────────────────────────────── */}
      <div className="bg-card rounded-xl border border-border p-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h2 className="font-semibold text-foreground">Store Plan</h2>
            <p className="text-sm text-muted-foreground mt-0.5">
              Current plan determines the feature baseline.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 text-primary px-3 py-1 text-sm font-medium">
              {PLAN_LABELS[plan].en}
              <span className="text-primary/70" dir="rtl">
                · {PLAN_LABELS[plan].ar}
              </span>
            </span>
            <select
              className="rounded-lg border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              value=""
              onChange={e => {
                const val = e.target.value as StorePlan;
                if (val && val !== plan) {
                  setPendingPlan(val);
                  setPlanModalOpen(true);
                }
              }}
            >
              <option value="">Change plan…</option>
              {STORE_PLANS.filter(p => p !== plan).map(p => (
                <option key={p} value={p}>
                  {PLAN_LABELS[p].en} — {PLAN_LABELS[p].ar}
                </option>
              ))}
            </select>
          </div>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Plan changes preserve all existing overrides. Baseline features update immediately.
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground" dir="rtl">
          تغيير الخطة يحافظ على كل الإعدادات المخصصة. تتحدث الميزات الأساسية فوراً.
        </p>
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
              plan={plan}
              overrideMap={overrideMap}
              inFlightKeys={inFlightKeys}
              onAction={handleAction}
            />
          );
        })}
      </div>

      {/* ── Danger Zone ──────────────────────────────────────────────────────── */}
      <div className="mt-8">
        <h2 className="mb-4 font-semibold text-destructive">Danger Zone</h2>
        <div className="rounded-xl border-2 border-destructive/40 bg-destructive/5 p-6 space-y-4">
          {/* Suspend / Reactivate */}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-sm font-medium text-foreground">
                {isSuspended ? 'Reactivate Store' : 'Suspend Store'}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {isSuspended
                  ? 'Allow customers to access and purchase from this store.'
                  : 'Block customer access to this store without deleting data.'}
              </p>
            </div>
            <div className="shrink-0">
              <Button
                variant={isSuspended ? 'default' : 'destructive'}
                onClick={() => setSuspendModalOpen(true)}
                disabled={statusChanging}
              >
                {isSuspended ? 'Reactivate Store' : 'Suspend Store'}
              </Button>
            </div>
          </div>

          <div className="border-t border-destructive/20" />

          {/* Reset overrides */}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-sm font-medium text-foreground">Reset to Plan Defaults</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Clear ALL feature overrides for this store. The store will use its plan baseline
                only.
              </p>
            </div>
            <div className="shrink-0">
              <Button
                variant="destructive"
                onClick={() => setResetModalOpen(true)}
                disabled={resetting}
              >
                Reset Overrides
              </Button>
            </div>
          </div>

          {/* Audit log link */}
          <div className="border-t border-destructive/20 pt-3">
            <Link href="/audit-logs" className="text-sm text-primary hover:underline">
              View audit logs →
            </Link>
          </div>
        </div>
      </div>

      {/* ── Modals ───────────────────────────────────────────────────────────── */}

      {/* Plan change confirm */}
      <Modal
        isOpen={planModalOpen}
        onClose={() => {
          setPlanModalOpen(false);
          setPendingPlan(null);
        }}
        title="Change Plan"
        size="sm"
      >
        <p className="text-sm text-muted-foreground">
          Changing plan to <strong>{pendingPlan ? PLAN_LABELS[pendingPlan].en : ''}</strong>.
          Feature overrides will be preserved. Continue?
        </p>
        <p className="text-sm text-muted-foreground mt-1" dir="rtl">
          تغيير الخطة إلى <strong>{pendingPlan ? PLAN_LABELS[pendingPlan].ar : ''}</strong>. ستُحفظ
          الإعدادات المخصصة. المتابعة؟
        </p>
        <div className="mt-6 flex justify-end gap-3">
          <Button
            variant="outline"
            onClick={() => {
              setPlanModalOpen(false);
              setPendingPlan(null);
            }}
            disabled={planChanging}
          >
            Cancel
          </Button>
          <Button
            variant="default"
            onClick={handlePlanChange}
            disabled={planChanging}
            isLoading={planChanging}
          >
            Confirm
          </Button>
        </div>
      </Modal>

      {/* Suspend / reactivate confirm */}
      <Modal
        isOpen={suspendModalOpen}
        onClose={() => setSuspendModalOpen(false)}
        title={isSuspended ? 'Reactivate Store' : 'Suspend Store'}
        size="sm"
      >
        <p className="text-sm text-muted-foreground">
          {isSuspended
            ? `Reactivate ${storeInfo.name}? Customers will regain access immediately.`
            : `Suspend ${storeInfo.name}? Customers will not be able to access or purchase from the store.`}
        </p>
        <div className="mt-6 flex justify-end gap-3">
          <Button
            variant="outline"
            onClick={() => setSuspendModalOpen(false)}
            disabled={statusChanging}
          >
            Cancel
          </Button>
          <Button
            variant={isSuspended ? 'default' : 'destructive'}
            onClick={handleStatusChange}
            disabled={statusChanging}
            isLoading={statusChanging}
          >
            {isSuspended ? 'Reactivate' : 'Suspend'}
          </Button>
        </div>
      </Modal>

      {/* Reset confirm */}
      <Modal
        isOpen={resetModalOpen}
        onClose={() => setResetModalOpen(false)}
        title="Reset to Plan Defaults"
        size="sm"
      >
        <p className="text-sm text-muted-foreground">
          This will clear ALL feature overrides for this store. The store will fall back to its{' '}
          <strong>{PLAN_LABELS[plan].en}</strong> plan baseline. This cannot be undone.
        </p>
        <div className="mt-6 flex justify-end gap-3">
          <Button variant="outline" onClick={() => setResetModalOpen(false)} disabled={resetting}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleReset}
            disabled={resetting}
            isLoading={resetting}
          >
            Reset All Overrides
          </Button>
        </div>
      </Modal>
    </div>
  );
}
