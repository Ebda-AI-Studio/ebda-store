'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { useToast } from '@force/ui';
import { useT } from '@/i18n/useT';
import { resolveLayoutSettings, type StoreLayoutSettings } from '@force/shared';
import { AdminLayout } from '../../../../components/AdminLayout';
import { Toggle } from '../../../../components/Toggle';
import { apiGet, apiPut } from '../../../../lib/api';

interface StoreInfo {
  id: string;
  slug: string;
  domain?: string | null;
}

type SectionUpdater<K extends keyof StoreLayoutSettings> = (
  prev: StoreLayoutSettings[K]
) => StoreLayoutSettings[K];

export default function StoreLayoutPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const t = useT('orders.layout');
  const { success: toastSuccess, error: toastError } = useToast();

  const [layout, setLayout] = useState<StoreLayoutSettings | null>(null);
  const [storeInfo, setStoreInfo] = useState<StoreInfo | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  const fetchData = useCallback(async () => {
    if (!storeId) return;
    setIsLoading(true);
    try {
      const [layoutRes, storeRes] = await Promise.all([
        apiGet<{ layout: StoreLayoutSettings }>(`/api/v1/admin/stores/${storeId}/layout`),
        apiGet<{ store: StoreInfo }>(`/api/v1/admin/stores/${storeId}`),
      ]);
      if (layoutRes.error) {
        toastError(t('loadError'));
      } else if (layoutRes.data?.layout) {
        setLayout(resolveLayoutSettings(layoutRes.data.layout));
      }
      if (storeRes.data?.store) {
        setStoreInfo(storeRes.data.store);
      }
    } finally {
      setIsLoading(false);
    }
  }, [storeId, t, toastError]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const updateSection = <K extends keyof StoreLayoutSettings>(
    key: K,
    updater: SectionUpdater<K>
  ) => {
    setLayout(prev => (prev ? { ...prev, [key]: updater(prev[key]) } : prev));
  };

  const handleSave = async () => {
    if (!layout) return;
    setIsSaving(true);
    try {
      const { error } = await apiPut(`/api/v1/admin/stores/${storeId}/layout`, layout);
      if (error) {
        toastError(t('saveError'));
      } else {
        toastSuccess(t('saved'));
      }
    } finally {
      setIsSaving(false);
    }
  };

  // Build a preview URL pointing at the storefront's home page. Prefer the
  // store's custom domain when available so the preview reflects the
  // production environment exactly; fall back to the default web app +
  // ?storeSlug query (handled by the web app's middleware).
  const previewUrl =
    storeInfo?.domain && storeInfo.domain.length > 0
      ? `https://${storeInfo.domain}`
      : storeInfo?.slug
        ? `${process.env.NEXT_PUBLIC_WEB_URL ?? 'https://force-web-sigma.vercel.app'}/?storeSlug=${storeInfo.slug}`
        : null;

  return (
    <AdminLayout
      mode="store_admin"
      storeId={storeId}
      title={t('title')}
      subtitle={t('subtitle')}
      actions={
        <button
          type="button"
          onClick={handleSave}
          disabled={!layout || isSaving}
          className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60 transition-colors cursor-pointer"
        >
          {isSaving ? t('saving') : t('save')}
        </button>
      }
    >
      <div className="mx-auto grid max-w-7xl gap-6 px-4 py-6 sm:px-6 lg:grid-cols-[minmax(0,1fr)_480px]">
        <div className="space-y-4">
          {isLoading && (
            <div className="rounded-2xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
              …
            </div>
          )}

          {!isLoading && layout && (
            <>
              {/* Hero */}
              <SectionCard
                title={t('sections.hero.title')}
                description={t('sections.hero.description')}
                enabled={layout.hero.enabled}
                onToggle={v => updateSection('hero', s => ({ ...s, enabled: v }))}
              >
                <div className="grid grid-cols-2 gap-2 mb-4">
                  <ModeButton
                    active={layout.hero.mode === 'single'}
                    onClick={() => updateSection('hero', s => ({ ...s, mode: 'single' }))}
                    label={t('sections.hero.modeSingle')}
                  />
                  <ModeButton
                    active={layout.hero.mode === 'slider'}
                    onClick={() => updateSection('hero', s => ({ ...s, mode: 'slider' }))}
                    label={t('sections.hero.modeSlider')}
                  />
                </div>
                {layout.hero.mode === 'slider' && (
                  <NumberField
                    label={t('sections.hero.autoplay')}
                    value={layout.hero.autoplayMs}
                    min={1000}
                    max={30000}
                    step={500}
                    onChange={v => updateSection('hero', s => ({ ...s, autoplayMs: v }))}
                  />
                )}
              </SectionCard>

              {/* Categories */}
              <SectionCard
                title={t('sections.categories.title')}
                description={t('sections.categories.description')}
                enabled={layout.categories.enabled}
                onToggle={v => updateSection('categories', s => ({ ...s, enabled: v }))}
              >
                <div className="grid grid-cols-2 gap-2 mb-3">
                  <ModeButton
                    active={layout.categories.layout === 'grid'}
                    onClick={() => updateSection('categories', s => ({ ...s, layout: 'grid' }))}
                    label={t('sections.categories.layoutGrid')}
                  />
                  <ModeButton
                    active={layout.categories.layout === 'horizontal'}
                    onClick={() =>
                      updateSection('categories', s => ({ ...s, layout: 'horizontal' }))
                    }
                    label={t('sections.categories.layoutHorizontal')}
                  />
                </div>
                <div className="grid grid-cols-2 gap-2 mb-3">
                  <ModeButton
                    active={layout.categories.captionPosition === 'below'}
                    onClick={() =>
                      updateSection('categories', s => ({ ...s, captionPosition: 'below' }))
                    }
                    label={t('sections.categories.captionBelow')}
                  />
                  <ModeButton
                    active={layout.categories.captionPosition === 'overlay'}
                    onClick={() =>
                      updateSection('categories', s => ({ ...s, captionPosition: 'overlay' }))
                    }
                    label={t('sections.categories.captionOverlay')}
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <SelectField
                    label={t('sections.categories.desktopColumns')}
                    value={layout.categories.desktopColumns}
                    options={[2, 3, 4]}
                    onChange={v =>
                      updateSection('categories', s => ({
                        ...s,
                        desktopColumns: v as 2 | 3 | 4,
                      }))
                    }
                  />
                  <SelectField
                    label={t('sections.categories.mobileColumns')}
                    value={layout.categories.mobileColumns}
                    options={[1, 2]}
                    onChange={v =>
                      updateSection('categories', s => ({
                        ...s,
                        mobileColumns: v as 1 | 2,
                      }))
                    }
                  />
                </div>
              </SectionCard>

              {/* New arrivals */}
              <SectionCard
                title={t('sections.newArrivals.title')}
                description={t('sections.newArrivals.description')}
                enabled={layout.newArrivals.enabled}
                onToggle={v => updateSection('newArrivals', s => ({ ...s, enabled: v }))}
              >
                <NumberField
                  label={t('sections.newArrivals.limit')}
                  value={layout.newArrivals.limit}
                  min={1}
                  max={48}
                  step={1}
                  onChange={v => updateSection('newArrivals', s => ({ ...s, limit: v }))}
                />
              </SectionCard>

              {/* Best sellers */}
              <SectionCard
                title={t('sections.bestSellers.title')}
                description={t('sections.bestSellers.description')}
                enabled={layout.bestSellers.enabled}
                onToggle={v => updateSection('bestSellers', s => ({ ...s, enabled: v }))}
              >
                <NumberField
                  label={t('sections.bestSellers.limit')}
                  value={layout.bestSellers.limit}
                  min={1}
                  max={48}
                  step={1}
                  onChange={v => updateSection('bestSellers', s => ({ ...s, limit: v }))}
                />
              </SectionCard>

              {/* Filter sidebar */}
              <SectionCard
                title={t('sections.filterSidebar.title')}
                description={t('sections.filterSidebar.description')}
                enabled={layout.filterSidebar.enabled}
                onToggle={v => updateSection('filterSidebar', s => ({ ...s, enabled: v }))}
              >
                <RowToggle
                  label={t('sections.filterSidebar.defaultOpen')}
                  checked={layout.filterSidebar.defaultOpen}
                  onChange={v => updateSection('filterSidebar', s => ({ ...s, defaultOpen: v }))}
                />
              </SectionCard>

              {/* Testimonials */}
              <SectionCard
                title={t('sections.testimonials.title')}
                description={t('sections.testimonials.description')}
                enabled={layout.testimonials.enabled}
                onToggle={v => updateSection('testimonials', s => ({ ...s, enabled: v }))}
              >
                <div className="grid grid-cols-2 gap-3">
                  <NumberField
                    label={t('sections.testimonials.minRating')}
                    value={layout.testimonials.minRating}
                    min={1}
                    max={5}
                    step={1}
                    onChange={v => updateSection('testimonials', s => ({ ...s, minRating: v }))}
                  />
                  <RowToggle
                    label={t('sections.testimonials.verifiedOnly')}
                    checked={layout.testimonials.verifiedOnly}
                    onChange={v => updateSection('testimonials', s => ({ ...s, verifiedOnly: v }))}
                  />
                </div>
              </SectionCard>

              {/* Sizing contract */}
              <SectionCard
                title={t('sections.sizing.title')}
                description={t('sections.sizing.description')}
                alwaysOn
              >
                <div className="grid grid-cols-3 gap-3">
                  <SelectField
                    label={t('sections.sizing.heroAspect')}
                    value={layout.sizing.heroAspect}
                    options={['2.45:1', '16:9', '4:3'] as const}
                    onChange={v =>
                      updateSection('sizing', s => ({
                        ...s,
                        heroAspect: v as StoreLayoutSettings['sizing']['heroAspect'],
                      }))
                    }
                  />
                  <SelectField
                    label={t('sections.sizing.productImageAspect')}
                    value={layout.sizing.productImageAspect}
                    options={['1:1', '3:4'] as const}
                    onChange={v =>
                      updateSection('sizing', s => ({
                        ...s,
                        productImageAspect:
                          v as StoreLayoutSettings['sizing']['productImageAspect'],
                      }))
                    }
                  />
                  <SelectField
                    label={t('sections.sizing.categoryImageAspect')}
                    value={layout.sizing.categoryImageAspect}
                    options={['1:1', '3:4', '2:3'] as const}
                    onChange={v =>
                      updateSection('sizing', s => ({
                        ...s,
                        categoryImageAspect:
                          v as StoreLayoutSettings['sizing']['categoryImageAspect'],
                      }))
                    }
                  />
                </div>
              </SectionCard>
            </>
          )}
        </div>

        {/* Live preview pane — sticky on lg+, hidden on mobile to keep the
            forms front-and-centre on small screens. */}
        <aside className="hidden lg:block">
          <div className="sticky top-4 space-y-3">
            <h3 className="text-sm font-semibold text-foreground">Preview</h3>
            {previewUrl ? (
              // The storefront's CSP refuses to be framed (X-Frame-Options:
              // DENY + frame-ancestors 'none'), which is correct for a
              // public e-commerce site to avoid clickjacking. We open the
              // preview in a new tab instead so changes are visible without
              // weakening storefront security.
              <a
                href={previewUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="block rounded-2xl border border-border bg-card p-6 text-center hover:bg-muted transition-colors"
              >
                <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
                  <svg
                    className="h-6 w-6"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    aria-hidden
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={1.5}
                      d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                    />
                  </svg>
                </div>
                <p className="text-sm font-semibold text-foreground">Open storefront preview</p>
                <p className="mt-1 text-xs text-muted-foreground break-all">{previewUrl}</p>
                <p className="mt-3 text-[11px] text-muted-foreground">
                  Opens in a new tab — your storefront blocks framing for security.
                </p>
              </a>
            ) : (
              <div className="rounded-2xl border border-border bg-card p-6 text-center text-xs text-muted-foreground">
                Preview unavailable — the store has no slug or domain configured.
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              Click <strong>Save changes</strong> to refresh the preview with your latest toggles.
            </p>
          </div>
        </aside>
      </div>
    </AdminLayout>
  );
}

interface SectionCardProps {
  title: string;
  description: string;
  enabled?: boolean;
  alwaysOn?: boolean;
  onToggle?: (v: boolean) => void;
  children?: React.ReactNode;
}

function SectionCard({
  title,
  description,
  enabled,
  alwaysOn,
  onToggle,
  children,
}: SectionCardProps) {
  return (
    <section className="rounded-2xl border border-border bg-card p-5">
      <div className="flex items-start justify-between gap-4 mb-3">
        <div>
          <h2 className="font-semibold text-foreground">{title}</h2>
          <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
        </div>
        {!alwaysOn && onToggle && <Toggle checked={!!enabled} onChange={onToggle} />}
      </div>
      {(alwaysOn || enabled) && children && (
        <div className="border-t border-border pt-4 mt-1">{children}</div>
      )}
    </section>
  );
}

function ModeButton({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-xl border px-3 py-2 text-sm font-medium transition-colors cursor-pointer ${
        active
          ? 'border-primary bg-primary/10 text-primary'
          : 'border-border bg-card text-foreground hover:bg-muted'
      }`}
    >
      {label}
    </button>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={e => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(n);
        }}
        className="rounded-lg border border-border bg-card px-3 py-2 text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
      />
    </label>
  );
}

function SelectField<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly T[];
  onChange: (v: T) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <select
        value={value}
        onChange={e => {
          const raw = e.target.value;
          const parsed = typeof options[0] === 'number' ? (Number(raw) as T) : (raw as T);
          onChange(parsed);
        }}
        className="rounded-lg border border-border bg-card px-3 py-2 text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
      >
        {options.map(o => (
          <option key={String(o)} value={o}>
            {String(o)}
          </option>
        ))}
      </select>
    </label>
  );
}

function RowToggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-3 py-2 text-sm">
      <span className="text-foreground">{label}</span>
      <Toggle checked={checked} onChange={onChange} />
    </label>
  );
}
