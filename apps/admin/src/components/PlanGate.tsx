'use client';

import type { ReactNode } from 'react';
import { useLocale } from 'next-intl';
import { useFeatures } from '../hooks/useFeatures';
import { useAuth } from '../lib/auth';
import { isPlanGateError, PLAN_GATE_FALLBACK } from '../lib/route-feature-gates';
import { AdminLayout } from './AdminLayout';
import { FeatureUpgradeGate } from './FeatureUpgradeGate';

interface PlanGateProps {
  storeId: string;
  /** The feature this screen needs. Entitlements are read once (AdminFeatureProvider); the page never mounts when it is off. */
  featureKey?: string | null;
  /** A response that still reached the page: a 402 / plan 403 becomes the locked card, never raw text. */
  error?: { status?: number; code?: string } | null;
  children: ReactNode;
}

/**
 * The one plan gate (audit G-2/G-3). Maps (a) an entitlement that is off and (b) a 402/403 from the API to the same
 * designed locked card used on /ai-tools, and never renders `error.message`. Super admins pass through.
 */
export function PlanGate({ storeId, featureKey, error, children }: PlanGateProps) {
  const { isEnabled, isLoading } = useFeatures();
  const { user } = useAuth();
  const locale = useLocale();
  const isSuperAdmin = user?.role === 'super_admin';

  if (isSuperAdmin) return <>{children}</>;

  if (featureKey && !isLoading && !isEnabled(featureKey)) {
    return <FeatureUpgradeGate featureKey={featureKey} storeId={storeId} />;
  }
  if (isPlanGateError(error)) {
    if (featureKey) return <FeatureUpgradeGate featureKey={featureKey} storeId={storeId} />;
    return (
      <AdminLayout title="">
        <div className="mx-auto max-w-lg px-4 py-16 text-center" role="status">
          <p className="text-base text-foreground">
            {PLAN_GATE_FALLBACK[locale === 'ar' ? 'ar' : 'en']}
          </p>
        </div>
      </AdminLayout>
    );
  }
  // Entitlements still loading on a gated route: render nothing so the page does not mount and fetch-then-fail.
  if (featureKey && isLoading) {
    return <div className="min-h-[40vh]" aria-busy="true" />;
  }
  return <>{children}</>;
}
