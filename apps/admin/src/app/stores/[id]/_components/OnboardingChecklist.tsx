'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useT } from '@/i18n/useT';
import { apiGet, apiPatch } from '../../../../lib/api';
import { useAuth } from '../../../../lib/auth';
import { useFeatures } from '../../../../hooks/useFeatures';
import type { Store } from './types';

/**
 * Onboarding checklist for a freshly-created store. Detects each step's
 * "done" status against existing API endpoints so it auto-completes as the
 * merchant fills in the underlying data. The card collapses to a one-line
 * banner once every applicable step is done so it doesn't dominate the
 * dashboard for established stores.
 *
 * Steps that can't be actioned by the current user (e.g. activation requires
 * super_admin) are still shown so the merchant knows what's outstanding,
 * but the CTA is suppressed.
 */

interface OnboardingChecklistProps {
  store: Store;
  onStoreActivated?: () => void;
}

interface PaymentConfig {
  provider: string;
  isEnabled: boolean;
}

interface ShippingZone {
  id: string;
  isActive: boolean;
}

interface LayoutResponse {
  layout?: {
    hero?: {
      slides?: unknown[];
    };
  };
}

// Each row's "done" check is async because it talks to the API; we keep the
// derived value local to this component so the dashboard doesn't have to
// thread state through every parent.
type StepKey =
  | 'addProduct'
  | 'uploadLogo'
  | 'configureLayout'
  | 'paymentMethod'
  | 'shipping'
  | 'activate';

interface StepStatus {
  key: StepKey;
  done: boolean;
  /** When false the row is suppressed entirely (e.g. feature gated off). */
  applicable: boolean;
}

export function OnboardingChecklist({ store, onStoreActivated }: OnboardingChecklistProps) {
  const t = useT('stores.dashboard.onboarding');
  const { user } = useAuth();
  const { isEnabled } = useFeatures();
  const isSuperAdmin = user?.role === 'super_admin';

  const [productCount, setProductCount] = useState<number | null>(null);
  const [hasPayment, setHasPayment] = useState<boolean | null>(null);
  const [hasShipping, setHasShipping] = useState<boolean | null>(null);
  const [hasLayoutHero, setHasLayoutHero] = useState<boolean | null>(null);
  const [activating, setActivating] = useState(false);
  const [activationError, setActivationError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  const storeId = store.id;

  // Fetch step-status signals in parallel. Each request lives behind a
  // try/catch so a 404 / 403 on any one endpoint doesn't blank the whole
  // checklist; missing data just maps to "not done yet".
  useEffect(() => {
    if (!storeId) return;
    let cancelled = false;

    async function fetchStatuses() {
      const [productsRes, paymentRes, shippingRes, layoutRes] = await Promise.all([
        apiGet<{ products: unknown[]; meta?: { total: number }; pagination?: { total: number } }>(
          `/api/v1/stores/${storeId}/products?limit=1`
        ),
        apiGet<{ storeConfigs?: PaymentConfig[]; configs?: PaymentConfig[] } | PaymentConfig[]>(
          `/api/v1/payment-settings/store/${storeId}`
        ),
        apiGet<{ zones?: ShippingZone[] }>(`/api/v1/stores/${storeId}/shipping?limit=1`),
        apiGet<LayoutResponse>(`/api/v1/admin/stores/${storeId}/layout`),
      ]);

      if (cancelled) return;

      // Products — read meta.total when present, else fall back to length.
      const total =
        productsRes.data?.meta?.total ??
        productsRes.data?.pagination?.total ??
        productsRes.data?.products?.length ??
        0;
      setProductCount(total);

      // Payment — accept all known response shapes (raw array, { configs }, { storeConfigs }).
      const paymentList = Array.isArray(paymentRes.data)
        ? paymentRes.data
        : ((paymentRes.data as { storeConfigs?: PaymentConfig[]; configs?: PaymentConfig[] })
            ?.storeConfigs ??
          (paymentRes.data as { storeConfigs?: PaymentConfig[]; configs?: PaymentConfig[] })
            ?.configs ??
          []);
      setHasPayment(paymentList.some(p => p.isEnabled));

      // Shipping endpoint returns `{ success, data: { zones, meta } }`;
      // apiGet unwraps `data` so we read `shippingRes.data.zones` directly.
      const zones = shippingRes.data?.zones ?? [];
      setHasShipping(zones.length > 0);

      // Layout — done if either layoutSettings has at least one hero slide
      // OR the legacy heroImage is set on the store record.
      const slides = layoutRes.data?.layout?.hero?.slides ?? [];
      setHasLayoutHero(slides.length > 0 || Boolean(store.heroImage));
    }

    void fetchStatuses();
    return () => {
      cancelled = true;
    };
  }, [storeId, store.heroImage]);

  // Activate-store handler. Only super_admin can flip the status; we still
  // render the row for store_admin so they understand what's pending, but
  // hide the button.
  const handleActivate = useCallback(async () => {
    if (!isSuperAdmin) return;
    setActivating(true);
    setActivationError(null);
    const { error } = await apiPatch(`/api/v1/stores/${storeId}/status`, { status: 'active' });
    setActivating(false);
    if (error) {
      setActivationError(error.message ?? t('activation.failed'));
      return;
    }
    onStoreActivated?.();
  }, [isSuperAdmin, storeId, onStoreActivated, t]);

  const steps: StepStatus[] = useMemo(
    () => [
      {
        key: 'addProduct',
        done: (productCount ?? 0) > 0,
        applicable: true,
      },
      {
        key: 'uploadLogo',
        done: Boolean(store.logo && store.logo.length > 0),
        applicable: true,
      },
      {
        key: 'configureLayout',
        done: Boolean(hasLayoutHero),
        applicable: true,
      },
      {
        key: 'paymentMethod',
        done: Boolean(hasPayment),
        applicable: true,
      },
      {
        key: 'shipping',
        done: Boolean(hasShipping),
        // Shipping isn't gated behind a feature flag today, so it's always
        // applicable. Defensive check stays so this still reads naturally
        // if a `shipping_zones` flag is added later.
        applicable: isEnabled('shipping_zones') !== false,
      },
      {
        key: 'activate',
        done: store.status === 'active',
        // Always applicable; we just hide the button for non-super-admins.
        applicable: true,
      },
    ],
    [productCount, hasPayment, hasShipping, hasLayoutHero, store.logo, store.status, isEnabled]
  );

  const applicableSteps = steps.filter(s => s.applicable);
  const doneCount = applicableSteps.filter(s => s.done).length;
  const totalCount = applicableSteps.length;
  const allDone = totalCount > 0 && doneCount === totalCount;

  // While the network calls are in flight some flags are still null. Avoid
  // flickering "completed" before we know — only render the collapsed
  // banner once every flag has resolved.
  const stillLoading =
    productCount === null || hasPayment === null || hasShipping === null || hasLayoutHero === null;

  if (allDone && !stillLoading) {
    if (dismissed) return null;
    return (
      <div className="mb-8 flex items-center justify-between rounded-xl border border-success/30 bg-success/5 px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-success/15 text-success">
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M5 13l4 4L19 7"
              />
            </svg>
          </div>
          <div>
            <p className="text-sm font-semibold text-foreground">{t('completeTitle')}</p>
            <p className="text-xs text-muted-foreground">
              {t('completeSummary', { done: doneCount, total: totalCount })}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
        >
          {t('dismiss')}
        </button>
      </div>
    );
  }

  return (
    <section
      aria-labelledby="onboarding-checklist-title"
      className="mb-8 rounded-2xl border border-border bg-card shadow-sm overflow-hidden"
    >
      <header className="flex items-start justify-between gap-4 border-b border-border/60 p-5">
        <div>
          <h2
            id="onboarding-checklist-title"
            className="text-base font-semibold text-foreground tracking-tight"
          >
            {t('title')}
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        <div className="flex items-center gap-2 whitespace-nowrap">
          <span className="text-xs font-medium text-muted-foreground tabular-nums">
            {t('progress', { done: doneCount, total: totalCount })}
          </span>
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={totalCount}
            aria-valuenow={doneCount}
            className="hidden h-1.5 w-32 overflow-hidden rounded-full bg-muted sm:block"
          >
            <div
              className="h-full bg-primary transition-[width] duration-500"
              style={{ width: totalCount > 0 ? `${(doneCount / totalCount) * 100}%` : '0%' }}
            />
          </div>
        </div>
      </header>

      <ul className="divide-y divide-border/60">
        {applicableSteps.map(step => (
          <ChecklistRow
            key={step.key}
            step={step}
            storeId={storeId}
            isSuperAdmin={isSuperAdmin}
            onActivate={handleActivate}
            activating={activating}
            activationError={activationError}
          />
        ))}
      </ul>
    </section>
  );
}

interface ChecklistRowProps {
  step: StepStatus;
  storeId: string;
  isSuperAdmin: boolean;
  onActivate: () => void;
  activating: boolean;
  activationError: string | null;
}

const STEP_LINKS: Record<StepKey, (storeId: string) => string | null> = {
  addProduct: storeId => `/stores/${storeId}/products/new`,
  uploadLogo: storeId => `/stores/${storeId}/branding`,
  configureLayout: storeId => `/stores/${storeId}/layout`,
  paymentMethod: storeId => `/stores/${storeId}/payment-settings`,
  shipping: storeId => `/stores/${storeId}/shipping`,
  activate: () => null,
};

function ChecklistRow({
  step,
  storeId,
  isSuperAdmin,
  onActivate,
  activating,
  activationError,
}: ChecklistRowProps) {
  const t = useT('stores.dashboard.onboarding.steps');
  const tBase = useT('stores.dashboard.onboarding');
  const labelKey = `${step.key}.title` as Parameters<typeof t>[0];
  const subtitleKey = `${step.key}.subtitle` as Parameters<typeof t>[0];
  const ctaKey = `${step.key}.cta` as Parameters<typeof t>[0];
  const href = STEP_LINKS[step.key](storeId);
  const isActivateRow = step.key === 'activate';

  return (
    <li className="flex items-start gap-4 px-5 py-4 transition-colors hover:bg-muted/40">
      <StatusIcon done={step.done} />
      <div className="min-w-0 flex-1">
        <p
          className={`text-sm font-semibold ${
            step.done ? 'text-muted-foreground line-through' : 'text-foreground'
          }`}
        >
          {t(labelKey)}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">{t(subtitleKey)}</p>
        {isActivateRow && activationError && (
          <p className="mt-1 text-xs text-destructive">{activationError}</p>
        )}
      </div>

      <div className="flex-shrink-0">
        {step.done ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2.5 py-0.5 text-xs font-medium text-success">
            {tBase('doneBadge')}
          </span>
        ) : isActivateRow ? (
          isSuperAdmin ? (
            <button
              type="button"
              onClick={onActivate}
              disabled={activating}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 disabled:opacity-60"
            >
              {activating ? tBase('activation.activating') : t(ctaKey)}
            </button>
          ) : (
            <span className="text-xs text-muted-foreground">{tBase('activation.adminOnly')}</span>
          )
        ) : href ? (
          <Link
            href={href}
            className="inline-flex items-center gap-1 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
          >
            {t(ctaKey)}
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </Link>
        ) : null}
      </div>
    </li>
  );
}

function StatusIcon({ done }: { done: boolean }) {
  if (done) {
    return (
      <span
        aria-hidden
        className="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-success text-white"
      >
        <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
        </svg>
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full border-2 border-dashed border-muted-foreground/40"
    />
  );
}
