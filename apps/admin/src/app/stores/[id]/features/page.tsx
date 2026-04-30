'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { useToast } from '@force/ui';
import { useT } from '@/i18n/useT';
import { AdminLayout } from '../../../../components/AdminLayout';
import { apiGet, apiPut } from '../../../../lib/api';
import type { FeatureKey, FeatureDefinition, FeatureCategory } from '@force/shared';
import { CategoryCard } from './_components/CategoryCard';

interface FeatureMetadata {
  featureKey: string;
  enabled: boolean;
  enabledAt: string | null;
  enabledBy: string | null;
  updatedAt: string;
}

interface FeaturesResponse {
  features: Record<string, boolean>;
  metadata: FeatureMetadata[];
  registry: Record<FeatureKey, FeatureDefinition>;
}

const CATEGORY_ORDER: FeatureCategory[] = ['commerce', 'marketing', 'operations', 'storefront'];

export default function StoreFeaturesPage() {
  const params = useParams();
  const storeId = params.id as string;
  const t = useT('features');

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [registry, setRegistry] = useState<Record<FeatureKey, FeatureDefinition> | null>(null);
  const [serverState, setServerState] = useState<Record<string, boolean>>({});
  const [metadata, setMetadata] = useState<FeatureMetadata[]>([]);

  // Per-feature in-flight tracking. The UI shows the optimistic value
  // immediately and a spinner on the in-flight row; on failure we revert
  // and toast. No "Save" button — auto-save on toggle. Merchants kept
  // forgetting to click Save, so toggling push off in admin felt
  // working but the storefront kept showing the prompt.
  const [pending, setPending] = useState<Record<string, boolean>>({});

  const { error: toastError } = useToast();

  // Display state = server truth + any optimistic value still in flight.
  const displayState: Record<string, boolean> = { ...serverState, ...pending };

  const metadataMap = new Map<string, FeatureMetadata>(metadata.map(m => [m.featureKey, m]));

  const fetchFeatures = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data, error: apiErr } = await apiGet<FeaturesResponse>(
        `/api/v1/admin/stores/${storeId}/features`
      );
      if (apiErr) {
        setError(apiErr.message || t('errors.loadFailed'));
      } else if (data) {
        setRegistry(data.registry);
        setServerState(data.features);
        setMetadata(data.metadata);
        setPending({});
      }
    } catch {
      setError(t('errors.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [storeId, t]);

  useEffect(() => {
    fetchFeatures();
  }, [fetchFeatures]);

  // Auto-save on toggle. PUTs the single change immediately, shows the
  // optimistic value while the request is in flight, reverts on failure.
  // The previous batched-save UX confused merchants — they'd flip a
  // toggle, leave the page, and the change never persisted. Toasts only
  // fire for errors so a routine flip stays quiet.
  async function handleToggle(key: string, next: boolean) {
    // Already in flight for this key — ignore the second tap.
    if (key in pending) return;

    setPending(prev => ({ ...prev, [key]: next }));
    try {
      const { error: apiErr } = await apiPut(`/api/v1/admin/stores/${storeId}/features`, {
        [key]: next,
      });
      if (apiErr) {
        toastError(t('toasts.errorTitle'), apiErr.message || t('errors.saveFailed'));
        // Drop the optimistic value so the row reverts to server truth.
        setPending(prev => {
          const copy = { ...prev };
          delete copy[key];
          return copy;
        });
        return;
      }
      // Success: promote the optimistic value to server state, clear
      // pending. We don't toast on every flip — too noisy for a row of
      // toggles. The visible state change is its own confirmation.
      setServerState(prev => ({ ...prev, [key]: next }));
      setPending(prev => {
        const copy = { ...prev };
        delete copy[key];
        return copy;
      });
    } catch {
      toastError(t('toasts.errorTitle'), t('errors.saveFailed'));
      setPending(prev => {
        const copy = { ...prev };
        delete copy[key];
        return copy;
      });
    }
  }

  if (loading) {
    return (
      <AdminLayout title={t('page.title')} subtitle={t('page.subtitleLoading')}>
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
        </div>
      </AdminLayout>
    );
  }

  if (error || !registry) {
    return (
      <AdminLayout title={t('page.title')} subtitle={t('page.subtitleLoading')}>
        <div className="flex flex-col items-center justify-center h-64 gap-4">
          <div className="w-16 h-16 bg-destructive/10 rounded-full flex items-center justify-center">
            <svg
              className="w-8 h-8 text-destructive"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
              />
            </svg>
          </div>
          <p className="text-muted-foreground">{error || t('errors.loadFailed')}</p>
          <button
            type="button"
            onClick={fetchFeatures}
            className="px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary/90 transition-colors"
          >
            {t('errors.retry')}
          </button>
        </div>
      </AdminLayout>
    );
  }

  const grouped: Record<FeatureCategory, FeatureDefinition[]> = {
    commerce: [],
    marketing: [],
    operations: [],
    storefront: [],
  };
  // Hide features marked as such in the registry — these are either not
  // implemented (customer_wallet / email_campaigns / staff_accounts) or
  // are platform-level and have no per-store impact (seo /
  // search_autocomplete). Showing them as toggleable was misleading
  // because flipping them did nothing or promised features that don't
  // ship yet. Audit on 2026-04-29 documented the gaps.
  for (const def of Object.values(registry)) {
    if (def.hidden) continue;
    grouped[def.category].push(def);
  }

  // `localState` was the batched-edit map; with auto-save it's empty
  // every render, but CategoryCard still wants to know which row is
  // mid-flight so it can show a spinner. We pass `pending` through that
  // prop slot — same idea, different lifecycle.
  return (
    <AdminLayout title={t('page.title')} subtitle={t('page.subtitle')}>
      <div className="space-y-6">
        {CATEGORY_ORDER.map(category => {
          const features = grouped[category];
          if (features.length === 0) return null;

          return (
            <CategoryCard
              key={category}
              category={category}
              features={features}
              displayState={displayState}
              localState={pending}
              metadataMap={metadataMap}
              saving={Object.keys(pending).length > 0}
              onToggle={handleToggle}
            />
          );
        })}
      </div>
    </AdminLayout>
  );
}
