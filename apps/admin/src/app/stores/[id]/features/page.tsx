'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { useToast } from '@force/ui';
import { AdminLayout } from '../../../../components/AdminLayout';
import { apiGet, apiPut } from '../../../../lib/api';
import type { FeatureKey, FeatureDefinition, FeatureCategory } from '@force/shared';

// ─── Types ────────────────────────────────────────────────────────────────────

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

// ─── Category Config ──────────────────────────────────────────────────────────

const CATEGORY_ORDER: FeatureCategory[] = ['commerce', 'marketing', 'operations', 'storefront'];

const CATEGORY_LABELS: Record<FeatureCategory, string> = {
  commerce: 'Commerce',
  marketing: 'Marketing',
  operations: 'Operations',
  storefront: 'Storefront',
};

const CATEGORY_COLORS: Record<FeatureCategory, { icon: string; bg: string; text: string }> = {
  commerce: { icon: 'bg-info/10', bg: 'bg-info', text: 'text-info' },
  marketing: { icon: 'bg-info/10', bg: 'bg-info', text: 'text-info' },
  operations: { icon: 'bg-primary/10', bg: 'bg-primary', text: 'text-primary' },
  storefront: { icon: 'bg-success/10', bg: 'bg-success', text: 'text-success' },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

// ─── Toggle Switch ────────────────────────────────────────────────────────────

function ToggleSwitch({
  enabled,
  onChange,
  disabled,
}: {
  enabled: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      onClick={() => !disabled && onChange(!enabled)}
      disabled={disabled}
      className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed ${
        enabled ? 'bg-primary' : 'bg-muted'
      }`}
    >
      <span
        className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
          enabled ? 'translate-x-5' : 'translate-x-0'
        }`}
      />
    </button>
  );
}

// ─── Category Icon ────────────────────────────────────────────────────────────

function CategoryIcon({ category }: { category: FeatureCategory }) {
  const colors = CATEGORY_COLORS[category];
  return (
    <div className={`flex h-8 w-8 items-center justify-center rounded-lg ${colors.icon}`}>
      {category === 'commerce' && (
        <svg
          className={`h-4 w-4 ${colors.text}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z"
          />
        </svg>
      )}
      {category === 'marketing' && (
        <svg
          className={`h-4 w-4 ${colors.text}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M11 5.882V19.24a1.76 1.76 0 01-3.417.592l-2.147-6.15M18 13a3 3 0 100-6M5.436 13.683A4.001 4.001 0 017 6h1.832c4.1 0 7.625-1.234 9.168-3v14c-1.543-1.766-5.067-3-9.168-3H7a3.988 3.988 0 01-1.564-.317z"
          />
        </svg>
      )}
      {category === 'operations' && (
        <svg
          className={`h-4 w-4 ${colors.text}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
          />
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
          />
        </svg>
      )}
      {category === 'storefront' && (
        <svg
          className={`h-4 w-4 ${colors.text}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
          />
        </svg>
      )}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function StoreFeaturesPage() {
  const params = useParams();
  const storeId = params.id as string;

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Current server state
  const [registry, setRegistry] = useState<Record<FeatureKey, FeatureDefinition> | null>(null);
  const [serverState, setServerState] = useState<Record<string, boolean>>({});
  const [metadata, setMetadata] = useState<FeatureMetadata[]>([]);

  // Local toggle state (what the user has changed)
  const [localState, setLocalState] = useState<Record<string, boolean>>({});

  const { success: toastSuccess, error: toastError } = useToast();

  // ── Derived ──────────────────────────────────────────────────────────────────

  // Merge server state with local overrides for display
  const displayState: Record<string, boolean> = { ...serverState, ...localState };

  // Keys that have been changed but not yet saved
  const dirtyKeys = Object.keys(localState).filter(k => localState[k] !== serverState[k]);
  const hasDirty = dirtyKeys.length > 0;

  const metadataMap = new Map<string, FeatureMetadata>(metadata.map(m => [m.featureKey, m]));

  // ── Fetch ────────────────────────────────────────────────────────────────────

  const fetchFeatures = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data, error: apiErr } = await apiGet<FeaturesResponse>(
        `/api/v1/admin/stores/${storeId}/features`
      );
      if (apiErr) {
        setError(apiErr.message || 'Failed to load features.');
      } else if (data) {
        setRegistry(data.registry);
        setServerState(data.features);
        setMetadata(data.metadata);
        setLocalState({}); // reset dirty state on fresh load
      }
    } catch {
      setError('Failed to load features. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [storeId]);

  useEffect(() => {
    fetchFeatures();
  }, [fetchFeatures]);

  // ── Toggle ───────────────────────────────────────────────────────────────────

  function handleToggle(key: string, next: boolean) {
    setLocalState(prev => {
      const updated = { ...prev, [key]: next };
      // If toggled back to server value, remove from dirty map
      if (next === serverState[key]) {
        const { [key]: _, ...rest } = updated;
        return rest;
      }
      return updated;
    });
  }

  // ── Save ─────────────────────────────────────────────────────────────────────

  async function handleSave() {
    if (!hasDirty) return;

    // Build payload: only the changed keys
    const updates: Record<string, boolean> = {};
    for (const key of dirtyKeys) {
      updates[key] = localState[key];
    }

    setSaving(true);
    try {
      const { error: apiErr } = await apiPut(`/api/v1/admin/stores/${storeId}/features`, updates);
      if (apiErr) {
        toastError('Error', apiErr.message || 'Failed to save features. Please try again.');
      } else {
        toastSuccess(
          'Features Saved',
          `${dirtyKeys.length} feature${dirtyKeys.length > 1 ? 's' : ''} updated successfully.`
        );
        // Refresh from server to get updated metadata
        await fetchFeatures();
      }
    } catch {
      toastError('Error', 'Failed to save features. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <AdminLayout title="Store Features" subtitle="Manage feature toggles for this store">
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
        </div>
      </AdminLayout>
    );
  }

  if (error || !registry) {
    return (
      <AdminLayout title="Store Features" subtitle="Manage feature toggles for this store">
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
          <p className="text-muted-foreground">{error || 'Failed to load features.'}</p>
          <button
            onClick={fetchFeatures}
            className="px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary/90 transition-colors"
          >
            Retry
          </button>
        </div>
      </AdminLayout>
    );
  }

  // Group registry entries by category
  const grouped: Record<FeatureCategory, FeatureDefinition[]> = {
    commerce: [],
    marketing: [],
    operations: [],
    storefront: [],
  };
  for (const def of Object.values(registry)) {
    grouped[def.category].push(def);
  }

  return (
    <AdminLayout
      title="Store Features"
      subtitle="Enable or disable features for this store"
      actions={
        hasDirty ? (
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground">
              {dirtyKeys.length} unsaved change{dirtyKeys.length > 1 ? 's' : ''}
            </span>
            <button
              onClick={() => setLocalState({})}
              disabled={saving}
              className="px-4 py-2 text-sm font-medium text-foreground border border-border rounded-lg hover:bg-muted transition-colors disabled:opacity-50"
            >
              Discard
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-2 bg-primary text-white text-sm font-medium rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50 flex items-center gap-2"
            >
              {saving && (
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" />
              )}
              Save Changes
            </button>
          </div>
        ) : undefined
      }
    >
      <div className="space-y-6">
        {CATEGORY_ORDER.map(category => {
          const features = grouped[category];
          if (features.length === 0) return null;

          const enabledCount = features.filter(f => displayState[f.key]).length;

          return (
            <div key={category} className="bg-card rounded-xl border border-border overflow-hidden">
              {/* Category Header */}
              <div className="flex items-center justify-between px-6 py-4 border-b border-border bg-muted/40">
                <div className="flex items-center gap-3">
                  <CategoryIcon category={category} />
                  <div>
                    <h2 className="font-semibold text-foreground">{CATEGORY_LABELS[category]}</h2>
                    <p className="text-xs text-muted-foreground">
                      {enabledCount} of {features.length} enabled
                    </p>
                  </div>
                </div>
              </div>

              {/* Feature Rows */}
              <div className="divide-y divide-border">
                {features.map(def => {
                  const isOn = displayState[def.key] ?? false;
                  const isDirty = def.key in localState;
                  const meta = metadataMap.get(def.key);

                  return (
                    <div
                      key={def.key}
                      className={`flex items-start justify-between px-6 py-4 transition-colors ${
                        isDirty ? 'bg-primary/5/50' : 'hover:bg-muted/30'
                      }`}
                    >
                      <div className="flex-1 min-w-0 mr-4">
                        <div className="flex items-center gap-2 mb-0.5">
                          <p className="font-medium text-foreground">{def.name}</p>
                          {isDirty && (
                            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-primary/10 text-primary">
                              unsaved
                            </span>
                          )}
                        </div>
                        <p className="text-sm text-muted-foreground">{def.description}</p>
                        {/* Metadata: only show when enabled and metadata exists */}
                        {isOn && meta?.enabledAt && meta?.enabledBy && (
                          <p className="text-xs text-muted-foreground mt-1">
                            Enabled by{' '}
                            <span className="font-medium text-foreground">{meta.enabledBy}</span> on{' '}
                            {formatDate(meta.enabledAt)}
                          </p>
                        )}
                      </div>
                      <div className="flex-shrink-0 pt-0.5">
                        <ToggleSwitch
                          enabled={isOn}
                          onChange={next => handleToggle(def.key, next)}
                          disabled={saving}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}

        {/* Sticky Save Bar — shown at bottom when there are dirty changes */}
        {hasDirty && (
          <div className="sticky bottom-4 z-10">
            <div className="bg-card border border-border rounded-xl shadow-lg px-6 py-4 flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                You have{' '}
                <span className="font-semibold text-foreground">
                  {dirtyKeys.length} unsaved change{dirtyKeys.length > 1 ? 's' : ''}
                </span>
              </p>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setLocalState({})}
                  disabled={saving}
                  className="px-4 py-2 text-sm font-medium text-foreground border border-border rounded-lg hover:bg-muted transition-colors disabled:opacity-50"
                >
                  Discard
                </button>
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="px-6 py-2 bg-primary text-white text-sm font-medium rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50 flex items-center gap-2"
                >
                  {saving && (
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" />
                  )}
                  Save Changes
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
