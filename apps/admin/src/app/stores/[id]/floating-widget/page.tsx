'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { useToast } from '@force/ui';
import { AdminLayout } from '../../../../components/AdminLayout';
import { apiGet, apiPut } from '../../../../lib/api';
import { ColorField } from '../../../../components/ColorField';
import { useFeatures } from '../../../../hooks/useFeatures';
import type {
  FloatingButton,
  FloatingButtonKind,
  FloatingExpandDirection,
  FloatingPosition,
  FloatingWidgetConfig,
  StoreTheme,
} from '@force/shared';
import { DEFAULT_FLOATING_WIDGET_CONFIG } from '@force/shared';

interface StoreInfo {
  id: string;
  name: string;
  theme?: StoreTheme;
  settings?: Record<string, unknown>;
  enabledFeatures?: string[];
}

const KIND_LABELS: Record<FloatingButtonKind, string> = {
  whatsapp: 'WhatsApp',
  instagram: 'Instagram',
  phone: 'Phone',
  email: 'Email',
  music: 'Background music',
  custom: 'Custom link',
};

const POSITION_LABELS: Record<FloatingPosition, string> = {
  br: 'Bottom-right',
  bl: 'Bottom-left',
  tr: 'Top-right',
  tl: 'Top-left',
};

const EXPAND_LABELS: Record<FloatingExpandDirection, string> = {
  up: 'Upward',
  down: 'Downward',
  left: 'Leftward',
  right: 'Rightward',
};

function genId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export default function FloatingWidgetPage() {
  const params = useParams();
  const storeId = params.id as string;
  const { success: toastSuccess, error: toastError } = useToast();
  // useFeatures hooks into the AdminFeatureProvider which fetches the
  // canonical /api/v1/admin/stores/:id/features endpoint. The admin
  // store endpoint doesn't include enabledFeatures, so checking
  // store.enabledFeatures directly was always falsy. Verified
  // 2026-05-21 — ahmad enabled floating_widget but the page kept
  // showing 'Feature not enabled' until this hook was used.
  const { isEnabled, isLoading: featuresLoading } = useFeatures();

  const [store, setStore] = useState<StoreInfo | null>(null);
  const [config, setConfig] = useState<FloatingWidgetConfig>(DEFAULT_FLOATING_WIDGET_CONFIG);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!storeId) return;
    apiGet<{ store: StoreInfo }>(`/api/v1/admin/stores/${storeId}`)
      .then(res => {
        if (res.data?.store) {
          setStore(res.data.store);
          const existing = res.data.store.settings?.floatingWidget as
            | FloatingWidgetConfig
            | undefined;
          setConfig({ ...DEFAULT_FLOATING_WIDGET_CONFIG, ...(existing ?? {}) });
        }
      })
      .finally(() => setLoading(false));
  }, [storeId]);

  const featureEnabled = isEnabled('floating_widget');

  const handleSave = useCallback(async () => {
    if (!store) return;
    setSaving(true);
    // 2026-05-21 v2 — dedicated /floating-widget endpoint. Previous fix
    // (round-tripping the whole settings JSON via PUT /stores/:id) was
    // correct in theory but fragile: stale local copies of `store.settings`
    // racing with the bulk-ai AEO sweep's settings writes could clobber
    // fields. The new endpoint accepts ONLY the widget config and merges
    // server-side, same pattern as announcement/branding/seo/contact.
    const res = await apiPut(`/api/v1/stores/${storeId}/floating-widget`, config);
    setSaving(false);
    if (res.error) {
      toastError(res.error.message || 'Save failed');
    } else {
      toastSuccess('Floating widget saved');
    }
  }, [store, storeId, config, toastSuccess, toastError]);

  const patch = (next: Partial<FloatingWidgetConfig>) => setConfig(prev => ({ ...prev, ...next }));

  const addButton = () => {
    setConfig(prev => ({
      ...prev,
      buttons: [...(prev.buttons ?? []), { id: genId(), kind: 'whatsapp' }],
    }));
  };
  const updateButton = (id: string, next: Partial<FloatingButton>) => {
    setConfig(prev => ({
      ...prev,
      buttons: (prev.buttons ?? []).map(b => (b.id === id ? { ...b, ...next } : b)),
    }));
  };
  const removeButton = (id: string) => {
    setConfig(prev => ({
      ...prev,
      buttons: (prev.buttons ?? []).filter(b => b.id !== id),
    }));
  };
  const moveButton = (id: string, delta: -1 | 1) => {
    setConfig(prev => {
      const buttons = [...(prev.buttons ?? [])];
      const idx = buttons.findIndex(b => b.id === id);
      const targetIdx = idx + delta;
      if (idx < 0 || targetIdx < 0 || targetIdx >= buttons.length) return prev;
      [buttons[idx], buttons[targetIdx]] = [buttons[targetIdx], buttons[idx]];
      return { ...prev, buttons };
    });
  };

  if (loading || featuresLoading) {
    return (
      <AdminLayout title="Floating widget" subtitle="Loading…">
        <div className="text-sm text-muted-foreground">Loading…</div>
      </AdminLayout>
    );
  }

  if (!featureEnabled) {
    return (
      <AdminLayout title="Floating widget" subtitle="Premium add-on">
        <div className="max-w-xl rounded-2xl border border-border bg-card p-8 text-center">
          <h2 className="mb-2 text-lg font-semibold text-foreground">Feature not enabled</h2>
          <p className="text-sm text-muted-foreground">
            Floating widget is a premium add-on. A super admin must enable it for this store before
            you can configure it. Contact Force AI to request access.
          </p>
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout
      title="Floating widget"
      subtitle="Sticky button group your customers see on every page"
    >
      <div className="space-y-6 pb-32">
        {/* Master enable */}
        <section className="rounded-2xl border border-border bg-card p-6">
          <label className="flex items-center justify-between gap-4 cursor-pointer">
            <span className="flex-1 min-w-0">
              <span className="block text-sm font-semibold text-foreground">
                Show widget on storefront
              </span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                When off, no widget renders even though the feature is enabled.
              </span>
            </span>
            <input
              type="checkbox"
              checked={config.enabled === true}
              onChange={e => patch({ enabled: e.target.checked })}
              className="h-5 w-5 cursor-pointer accent-primary"
            />
          </label>
        </section>

        {/* Position + expand direction */}
        <section className="grid gap-4 rounded-2xl border border-border bg-card p-6 md:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Position</span>
            <select
              value={config.position ?? 'br'}
              onChange={e => patch({ position: e.target.value as FloatingPosition })}
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
            >
              {Object.entries(POSITION_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Expand direction</span>
            <select
              value={config.expandDirection ?? 'up'}
              onChange={e => patch({ expandDirection: e.target.value as FloatingExpandDirection })}
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
            >
              {Object.entries(EXPAND_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={config.startExpanded === true}
              onChange={e => patch({ startExpanded: e.target.checked })}
              className="h-4 w-4 cursor-pointer accent-primary"
            />
            <span className="text-sm text-foreground">Start expanded on every page load</span>
          </label>
          <div className="flex flex-wrap items-center gap-4 text-sm text-foreground">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={config.hideOnMobile === true}
                onChange={e => patch({ hideOnMobile: e.target.checked })}
                className="h-4 w-4 cursor-pointer accent-primary"
              />
              Hide on mobile
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={config.hideOnDesktop === true}
                onChange={e => patch({ hideOnDesktop: e.target.checked })}
                className="h-4 w-4 cursor-pointer accent-primary"
              />
              Hide on desktop
            </label>
          </div>
        </section>

        {/* Toggle button styling */}
        <section className="space-y-4 rounded-2xl border border-border bg-card p-6">
          <header>
            <h2 className="text-base font-semibold text-foreground">Toggle button</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              The always-visible circle. Click expands the rest.
            </p>
          </header>
          <ColorField
            label="Background color"
            value={config.toggleBgColor}
            onChange={v => patch({ toggleBgColor: v || undefined })}
            theme={store?.theme}
          />
          <div className="grid gap-4 md:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Tooltip (English)</span>
              <input
                type="text"
                value={config.toggleLabel ?? ''}
                onChange={e => patch({ toggleLabel: e.target.value })}
                placeholder="Open menu"
                className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Tooltip (Arabic)</span>
              <input
                type="text"
                value={config.toggleLabelAr ?? ''}
                onChange={e => patch({ toggleLabelAr: e.target.value })}
                placeholder="القائمة"
                dir="rtl"
                className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
              />
            </label>
          </div>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">
              Custom icon URL (optional)
            </span>
            <input
              type="url"
              value={config.toggleIconUrl ?? ''}
              onChange={e => patch({ toggleIconUrl: e.target.value })}
              placeholder="https://…/icon.png"
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
            />
          </label>
        </section>

        {/* Buttons list */}
        <section className="space-y-4 rounded-2xl border border-border bg-card p-6">
          <header className="flex items-center justify-between gap-2">
            <div>
              <h2 className="text-base font-semibold text-foreground">Buttons</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Actions revealed when the toggle expands. Reorder with the arrows.
              </p>
            </div>
            <button
              type="button"
              onClick={addButton}
              className="rounded-lg border border-border bg-background px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted"
            >
              + Add button
            </button>
          </header>
          {(config.buttons ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No buttons yet — add one above (WhatsApp, Instagram, music, etc.).
            </p>
          ) : (
            <ul className="space-y-3">
              {(config.buttons ?? []).map((b, i, arr) => (
                <li key={b.id} className="rounded-xl border border-border bg-background p-4">
                  <div className="flex items-start gap-3">
                    <div className="flex flex-col gap-1 pt-1">
                      <button
                        type="button"
                        onClick={() => moveButton(b.id, -1)}
                        disabled={i === 0}
                        className="touch-target rounded text-muted-foreground hover:bg-muted disabled:opacity-30"
                        aria-label="Move up"
                      >
                        ▲
                      </button>
                      <button
                        type="button"
                        onClick={() => moveButton(b.id, 1)}
                        disabled={i === arr.length - 1}
                        className="touch-target rounded text-muted-foreground hover:bg-muted disabled:opacity-30"
                        aria-label="Move down"
                      >
                        ▼
                      </button>
                    </div>
                    <div className="flex-1 space-y-3">
                      <div className="grid gap-3 md:grid-cols-2">
                        <label className="flex flex-col gap-1">
                          <span className="text-xs font-medium text-muted-foreground">Kind</span>
                          <select
                            value={b.kind}
                            onChange={e =>
                              updateButton(b.id, { kind: e.target.value as FloatingButtonKind })
                            }
                            className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
                          >
                            {Object.entries(KIND_LABELS).map(([k, v]) => (
                              <option key={k} value={k}>
                                {v}
                              </option>
                            ))}
                          </select>
                        </label>
                        <div className="grid gap-2 md:grid-cols-2">
                          <input
                            type="text"
                            value={b.label ?? ''}
                            onChange={e => updateButton(b.id, { label: e.target.value })}
                            placeholder="Tooltip (EN)"
                            className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
                          />
                          <input
                            type="text"
                            value={b.labelAr ?? ''}
                            onChange={e => updateButton(b.id, { labelAr: e.target.value })}
                            placeholder="التسمية"
                            dir="rtl"
                            className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
                          />
                        </div>
                      </div>

                      {/* Kind-specific config */}
                      {b.kind === 'whatsapp' && (
                        <div className="grid gap-3 md:grid-cols-2">
                          <label className="flex flex-col gap-1">
                            <span className="text-xs font-medium text-muted-foreground">
                              Phone (international, no + or spaces)
                            </span>
                            <input
                              type="text"
                              value={b.whatsappPhone ?? ''}
                              onChange={e => updateButton(b.id, { whatsappPhone: e.target.value })}
                              placeholder="96522668490"
                              className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
                            />
                          </label>
                          <label className="flex flex-col gap-1">
                            <span className="text-xs font-medium text-muted-foreground">
                              Pre-filled message (optional)
                            </span>
                            <input
                              type="text"
                              value={b.whatsappMessage ?? ''}
                              onChange={e =>
                                updateButton(b.id, { whatsappMessage: e.target.value })
                              }
                              placeholder="Hi! I'd like to ask about…"
                              className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
                            />
                          </label>
                        </div>
                      )}
                      {b.kind === 'instagram' && (
                        <label className="flex flex-col gap-1">
                          <span className="text-xs font-medium text-muted-foreground">
                            Instagram handle (no @)
                          </span>
                          <input
                            type="text"
                            value={b.instagramHandle ?? ''}
                            onChange={e => updateButton(b.id, { instagramHandle: e.target.value })}
                            placeholder="wadyaljuz"
                            className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
                          />
                        </label>
                      )}
                      {b.kind === 'phone' && (
                        <label className="flex flex-col gap-1">
                          <span className="text-xs font-medium text-muted-foreground">
                            Phone number
                          </span>
                          <input
                            type="text"
                            value={b.phoneNumber ?? ''}
                            onChange={e => updateButton(b.id, { phoneNumber: e.target.value })}
                            placeholder="+96522668490"
                            className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
                          />
                        </label>
                      )}
                      {b.kind === 'email' && (
                        <div className="grid gap-3 md:grid-cols-2">
                          <label className="flex flex-col gap-1">
                            <span className="text-xs font-medium text-muted-foreground">
                              Email address
                            </span>
                            <input
                              type="email"
                              value={b.emailAddress ?? ''}
                              onChange={e => updateButton(b.id, { emailAddress: e.target.value })}
                              placeholder="info@store.com"
                              className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
                            />
                          </label>
                          <label className="flex flex-col gap-1">
                            <span className="text-xs font-medium text-muted-foreground">
                              Default subject (optional)
                            </span>
                            <input
                              type="text"
                              value={b.emailSubject ?? ''}
                              onChange={e => updateButton(b.id, { emailSubject: e.target.value })}
                              placeholder="Question about your store"
                              className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
                            />
                          </label>
                        </div>
                      )}
                      {b.kind === 'music' && (
                        <div className="space-y-3">
                          <label className="flex flex-col gap-1">
                            <span className="text-xs font-medium text-muted-foreground">
                              Audio URL (mp3 / ogg / m4a)
                            </span>
                            <input
                              type="url"
                              value={b.musicUrl ?? ''}
                              onChange={e => updateButton(b.id, { musicUrl: e.target.value })}
                              placeholder="https://r2.dev/.../track.mp3"
                              className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
                            />
                          </label>
                          <label className="flex items-center gap-2 text-sm cursor-pointer">
                            <input
                              type="checkbox"
                              checked={b.musicLoop !== false}
                              onChange={e => updateButton(b.id, { musicLoop: e.target.checked })}
                              className="h-4 w-4 cursor-pointer accent-primary"
                            />
                            Loop audio (background music)
                          </label>
                        </div>
                      )}
                      {b.kind === 'custom' && (
                        <div className="grid gap-3 md:grid-cols-2">
                          <label className="flex flex-col gap-1">
                            <span className="text-xs font-medium text-muted-foreground">
                              Target URL
                            </span>
                            <input
                              type="url"
                              value={b.customHref ?? ''}
                              onChange={e => updateButton(b.id, { customHref: e.target.value })}
                              placeholder="https://…"
                              className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
                            />
                          </label>
                          <label className="flex flex-col gap-1">
                            <span className="text-xs font-medium text-muted-foreground">
                              Icon URL (optional)
                            </span>
                            <input
                              type="url"
                              value={b.iconUrl ?? ''}
                              onChange={e => updateButton(b.id, { iconUrl: e.target.value })}
                              placeholder="https://…/icon.svg"
                              className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
                            />
                          </label>
                        </div>
                      )}

                      <div className="grid gap-3 md:grid-cols-2">
                        <ColorField
                          label="Background color (optional)"
                          value={b.bgColor}
                          onChange={v => updateButton(b.id, { bgColor: v || undefined })}
                          theme={store?.theme}
                        />
                        <ColorField
                          label="Icon color (optional)"
                          value={b.iconColor}
                          onChange={v => updateButton(b.id, { iconColor: v || undefined })}
                          theme={store?.theme}
                        />
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => removeButton(b.id)}
                      className="rounded p-2 text-destructive hover:bg-destructive/10"
                      aria-label="Remove button"
                    >
                      ✕
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {/* Sticky save bar */}
      <div className="fixed bottom-0 inset-x-0 z-40 border-t border-border bg-background/95 backdrop-blur md:left-64">
        <div className="flex items-center justify-between gap-4 px-6 py-4">
          <span className="text-xs text-muted-foreground">
            Changes apply to the live storefront after save.
          </span>
          <button
            type="button"
            disabled={saving}
            onClick={handleSave}
            className="rounded-xl bg-primary px-6 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
          >
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>
    </AdminLayout>
  );
}
