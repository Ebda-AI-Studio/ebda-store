'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { useToast } from '@force/ui';
import { useT } from '@/i18n/useT';
import { AdminLayout } from '../../../../components/AdminLayout';
import { apiGet, apiPut } from '../../../../lib/api';
import type { FeatureKey, FeatureDefinition, FeatureCategory } from '@force/shared';
import { CategoryCard } from './_components/CategoryCard';
import { UnsavedChangesBar } from './_components/UnsavedChangesBar';

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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [registry, setRegistry] = useState<Record<FeatureKey, FeatureDefinition> | null>(null);
  const [serverState, setServerState] = useState<Record<string, boolean>>({});
  const [metadata, setMetadata] = useState<FeatureMetadata[]>([]);

  const [localState, setLocalState] = useState<Record<string, boolean>>({});

  const { success: toastSuccess, error: toastError } = useToast();

  const displayState: Record<string, boolean> = { ...serverState, ...localState };

  const dirtyKeys = Object.keys(localState).filter(k => localState[k] !== serverState[k]);
  const hasDirty = dirtyKeys.length > 0;

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
        setLocalState({});
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

  function handleToggle(key: string, next: boolean) {
    setLocalState(prev => {
      const updated = { ...prev, [key]: next };
      if (next === serverState[key]) {
        const copy = { ...updated };
        delete copy[key];
        return copy;
      }
      return updated;
    });
  }

  async function handleSave() {
    if (!hasDirty) return;

    const updates: Record<string, boolean> = {};
    for (const key of dirtyKeys) {
      updates[key] = localState[key];
    }

    setSaving(true);
    try {
      const { error: apiErr } = await apiPut(`/api/v1/admin/stores/${storeId}/features`, updates);
      if (apiErr) {
        toastError(t('toasts.errorTitle'), apiErr.message || t('errors.saveFailed'));
      } else {
        toastSuccess(
          t('toasts.savedTitle'),
          t('toasts.savedDescription', { count: dirtyKeys.length })
        );
        await fetchFeatures();
      }
    } catch {
      toastError(t('toasts.errorTitle'), t('errors.saveFailed'));
    } finally {
      setSaving(false);
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

  return (
    <AdminLayout
      title={t('page.title')}
      subtitle={t('page.subtitle')}
      actions={
        hasDirty ? (
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground">
              {t('actions.unsavedChanges', { count: dirtyKeys.length })}
            </span>
            <button
              type="button"
              onClick={() => setLocalState({})}
              disabled={saving}
              className="px-4 py-2 text-sm font-medium text-foreground border border-border rounded-lg hover:bg-muted transition-colors disabled:opacity-50"
            >
              {t('actions.discard')}
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-2 bg-primary text-white text-sm font-medium rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50 flex items-center gap-2"
            >
              {saving && (
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" />
              )}
              {t('actions.saveChanges')}
            </button>
          </div>
        ) : undefined
      }
    >
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
              localState={localState}
              metadataMap={metadataMap}
              saving={saving}
              onToggle={handleToggle}
            />
          );
        })}

        {hasDirty && (
          <UnsavedChangesBar
            dirtyCount={dirtyKeys.length}
            saving={saving}
            onDiscard={() => setLocalState({})}
            onSave={handleSave}
          />
        )}
      </div>
    </AdminLayout>
  );
}
