'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { useToast } from '@force/ui';
import { useT } from '@/i18n/useT';
import { resolveLayoutSettings, type StoreLayoutSettings, type HeroSlide } from '@force/shared';
import { AdminLayout } from '../../../../components/AdminLayout';
import { Toggle } from '../../../../components/Toggle';
import { ImageUpload } from '../../../../components/ImageUpload';
import { apiGet, apiPost, apiPut } from '../../../../lib/api';
import { getStoreHref } from '../../../../lib/store-url';

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
  // production environment exactly; otherwise fall back to the platform
  // domain + path-based slug (`/<store-slug>`) — that is the route shape the
  // web app's middleware actually resolves; a `?storeSlug=` query gets
  // ignored and falls through to whichever store the platform serves at /.
  const previewUrl = storeInfo?.slug ? getStoreHref(storeInfo) : null;

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
              {/* Hero — single image OR autoplay slider. The two modes share
                  the same slide list; "Static" pins to the first slide and
                  hides the autoplay control. */}
              <SectionCard
                title={t('sections.hero.title')}
                description={t('sections.hero.description')}
                enabled={layout.hero.enabled}
                onToggle={v => updateSection('hero', s => ({ ...s, enabled: v }))}
              >
                <div className="mb-2 text-xs font-medium text-muted-foreground">
                  {t('sections.hero.modeLabel')}
                </div>
                <div className="grid grid-cols-2 gap-2 mb-2">
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
                <p className="mb-4 text-xs text-muted-foreground">
                  {layout.hero.mode === 'single'
                    ? t('sections.hero.modeSingleHint')
                    : t('sections.hero.modeSliderHint')}
                </p>
                {/* Autoplay only matters in slider mode — hide it entirely
                    when the merchant has picked the static single banner so
                    the form doesn't expose an irrelevant control. */}
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
                <SlidesEditor
                  slides={layout.hero.slides}
                  storeId={storeId}
                  onChange={next => updateSection('hero', s => ({ ...s, slides: next }))}
                />
              </SectionCard>

              {/* Categories */}
              <SectionCard
                title={t('sections.categories.title')}
                description={t('sections.categories.description')}
                enabled={layout.categories.enabled}
                onToggle={v => updateSection('categories', s => ({ ...s, enabled: v }))}
              >
                {/* Desktop controls */}
                <p className="mt-2 mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {t('sections.categories.desktopLabel')}
                </p>
                <div className="grid grid-cols-2 gap-2 mb-2">
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
                <div className="grid grid-cols-2 gap-2 mb-2">
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
                <div className="mb-4">
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
                </div>

                {/* Mobile controls (split per 2026-05-16 mobile-ui-ship plan) */}
                <p className="mt-2 mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {t('sections.categories.mobileLabel')}
                </p>
                <div className="grid grid-cols-2 gap-2 mb-2">
                  <ModeButton
                    active={(layout.categories.layoutMobile ?? layout.categories.layout) === 'grid'}
                    onClick={() =>
                      updateSection('categories', s => ({ ...s, layoutMobile: 'grid' }))
                    }
                    label={t('sections.categories.layoutGrid')}
                  />
                  <ModeButton
                    active={
                      (layout.categories.layoutMobile ?? layout.categories.layout) === 'horizontal'
                    }
                    onClick={() =>
                      updateSection('categories', s => ({ ...s, layoutMobile: 'horizontal' }))
                    }
                    label={t('sections.categories.layoutHorizontal')}
                  />
                </div>
                <div className="grid grid-cols-2 gap-2 mb-2">
                  <ModeButton
                    active={
                      (layout.categories.captionPositionMobile ??
                        layout.categories.captionPosition) === 'below'
                    }
                    onClick={() =>
                      updateSection('categories', s => ({ ...s, captionPositionMobile: 'below' }))
                    }
                    label={t('sections.categories.captionBelow')}
                  />
                  <ModeButton
                    active={
                      (layout.categories.captionPositionMobile ??
                        layout.categories.captionPosition) === 'overlay'
                    }
                    onClick={() =>
                      updateSection('categories', s => ({
                        ...s,
                        captionPositionMobile: 'overlay',
                      }))
                    }
                    label={t('sections.categories.captionOverlay')}
                  />
                </div>
                <div>
                  <SelectField
                    label={t('sections.categories.mobileColumns')}
                    value={layout.categories.mobileColumns}
                    options={[1, 2, 3]}
                    onChange={v =>
                      updateSection('categories', s => ({
                        ...s,
                        mobileColumns: v as 1 | 2 | 3,
                      }))
                    }
                  />
                </div>
                <SectionTitleFields
                  title={layout.categories.title}
                  titleAr={layout.categories.titleAr}
                  labelEn={t('sections.categories.headingLabel')}
                  labelAr={t('sections.categories.headingArLabel')}
                  placeholderEn={t('sections.categories.headingPlaceholder')}
                  placeholderAr={t('sections.categories.headingArPlaceholder')}
                  onChangeTitle={v => updateSection('categories', s => ({ ...s, title: v }))}
                  onChangeTitleAr={v => updateSection('categories', s => ({ ...s, titleAr: v }))}
                />
                {/* Kicker (eyebrow badge) + Subtitle — bilingual, optional.
                    Kicker renders as a small colored chip above the title;
                    subtitle as a tagline below. AI Generate button fills
                    all 4 fields at once based on store context. Ahmad
                    2026-05-16. */}
                <div className="mt-3 flex items-center justify-between gap-2">
                  <p className="text-xs text-muted-foreground">
                    Optional kicker + subtitle. Leave blank to skip.
                  </p>
                  <AiSectionFillButton
                    storeId={storeId}
                    section="categories"
                    existingTitle={layout.categories.title}
                    existingTitleAr={layout.categories.titleAr}
                    onFilled={r =>
                      updateSection('categories', s => ({
                        ...s,
                        kicker: s.kicker || r.kicker,
                        kickerAr: s.kickerAr || r.kickerAr,
                        subtitle: s.subtitle || r.subtitle,
                        subtitleAr: s.subtitleAr || r.subtitleAr,
                      }))
                    }
                  />
                </div>
                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <TextField
                    label="Kicker label (EN)"
                    placeholder="e.g. EXPLORE"
                    value={layout.categories.kicker ?? ''}
                    onChange={v => updateSection('categories', s => ({ ...s, kicker: v }))}
                  />
                  <TextField
                    label="Kicker label (AR)"
                    placeholder="مثال: استكشف"
                    value={layout.categories.kickerAr ?? ''}
                    onChange={v => updateSection('categories', s => ({ ...s, kickerAr: v }))}
                    dir="rtl"
                  />
                  <TextField
                    label="Subtitle (EN)"
                    placeholder="e.g. Browse our top picks by category"
                    value={layout.categories.subtitle ?? ''}
                    onChange={v => updateSection('categories', s => ({ ...s, subtitle: v }))}
                  />
                  <TextField
                    label="Subtitle (AR)"
                    placeholder="مثال: تصفح أفضل اختياراتنا حسب الفئة"
                    value={layout.categories.subtitleAr ?? ''}
                    onChange={v => updateSection('categories', s => ({ ...s, subtitleAr: v }))}
                    dir="rtl"
                  />
                </div>
                {/* Card size, aspect, and visual toggles — Ahmad 2026-05-16
                    'make categories smaller + add options through admin'. */}
                {/* Card size / aspect / toggles — native selects with
                    descriptive labels (SelectField only accepts flat
                    string arrays). */}
                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="text-muted-foreground">Card size</span>
                    <select
                      value={layout.categories.cardSize ?? 'sm'}
                      onChange={e =>
                        updateSection('categories', s => ({
                          ...s,
                          cardSize: e.target.value as 'xs' | 'sm' | 'md' | 'lg' | 'xl',
                        }))
                      }
                      className="rounded-lg border border-border bg-card px-3 py-2 text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                    >
                      <option value="xs">Extra small (120/140px)</option>
                      <option value="sm">Small (150/180px) — default</option>
                      <option value="md">Medium (200/240px)</option>
                      <option value="lg">Large (240/300px)</option>
                      <option value="xl">Extra large (280/360px)</option>
                    </select>
                  </label>
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="text-muted-foreground">Image aspect</span>
                    <select
                      value={layout.categories.cardAspect ?? 'theme'}
                      onChange={e =>
                        updateSection('categories', s => ({
                          ...s,
                          cardAspect: e.target.value as
                            | 'theme'
                            | 'square'
                            | 'portrait'
                            | 'landscape',
                        }))
                      }
                      className="rounded-lg border border-border bg-card px-3 py-2 text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                    >
                      <option value="theme">Theme default</option>
                      <option value="square">Square 1:1</option>
                      <option value="portrait">Portrait 3:4</option>
                      <option value="landscape">Landscape 4:3</option>
                    </select>
                  </label>
                  <RowToggle
                    label="Show category labels"
                    checked={layout.categories.showLabel !== false}
                    onChange={v => updateSection('categories', s => ({ ...s, showLabel: v }))}
                  />
                  <RowToggle
                    label="Hover effects"
                    checked={layout.categories.showHover !== false}
                    onChange={v => updateSection('categories', s => ({ ...s, showHover: v }))}
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
                <SectionTitleFields
                  title={layout.newArrivals.title}
                  titleAr={layout.newArrivals.titleAr}
                  labelEn={t('sections.newArrivals.headingLabel')}
                  labelAr={t('sections.newArrivals.headingArLabel')}
                  placeholderEn={t('sections.newArrivals.headingPlaceholder')}
                  placeholderAr={t('sections.newArrivals.headingArPlaceholder')}
                  onChangeTitle={v => updateSection('newArrivals', s => ({ ...s, title: v }))}
                  onChangeTitleAr={v => updateSection('newArrivals', s => ({ ...s, titleAr: v }))}
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
                <SectionTitleFields
                  title={layout.bestSellers.title}
                  titleAr={layout.bestSellers.titleAr}
                  labelEn={t('sections.bestSellers.headingLabel')}
                  labelAr={t('sections.bestSellers.headingArLabel')}
                  placeholderEn={t('sections.bestSellers.headingPlaceholder')}
                  placeholderAr={t('sections.bestSellers.headingArPlaceholder')}
                  onChangeTitle={v => updateSection('bestSellers', s => ({ ...s, title: v }))}
                  onChangeTitleAr={v => updateSection('bestSellers', s => ({ ...s, titleAr: v }))}
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
                <SectionTitleFields
                  title={layout.testimonials.title}
                  titleAr={layout.testimonials.titleAr}
                  labelEn={t('sections.testimonials.headingLabel')}
                  labelAr={t('sections.testimonials.headingArLabel')}
                  placeholderEn={t('sections.testimonials.headingPlaceholder')}
                  placeholderAr={t('sections.testimonials.headingArPlaceholder')}
                  onChangeTitle={v => updateSection('testimonials', s => ({ ...s, title: v }))}
                  onChangeTitleAr={v => updateSection('testimonials', s => ({ ...s, titleAr: v }))}
                />
              </SectionCard>

              {/* Product reviews (sibling of testimonials — both UGC) */}
              <SectionCard
                title={t('sections.reviewSection.title')}
                description={t('sections.reviewSection.description')}
                enabled={layout.reviewSection.enabled}
                onToggle={v => updateSection('reviewSection', s => ({ ...s, enabled: v }))}
              />

              {/* Sizing contract — each field has a small visual preview
                  showing the actual aspect ratio so merchants can see what
                  they're picking before saving (ahmad's ask 2026-05-16:
                  bare numbers like '2.45:1' weren't intuitive). */}
              <SectionCard
                title={t('sections.sizing.title')}
                description={t('sections.sizing.description')}
                alwaysOn
              >
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <SizingFieldWithPreview
                    label={t('sections.sizing.heroAspect')}
                    value={layout.sizing.heroAspect}
                    options={['2.45:1', '16:9', '4:3']}
                    onChange={v =>
                      updateSection('sizing', s => ({
                        ...s,
                        heroAspect: v as StoreLayoutSettings['sizing']['heroAspect'],
                      }))
                    }
                  />
                  <SizingFieldWithPreview
                    label={t('sections.sizing.productImageAspect')}
                    value={layout.sizing.productImageAspect}
                    options={['1:1', '3:4']}
                    onChange={v =>
                      updateSection('sizing', s => ({
                        ...s,
                        productImageAspect:
                          v as StoreLayoutSettings['sizing']['productImageAspect'],
                      }))
                    }
                  />
                  <SizingFieldWithPreview
                    label={t('sections.sizing.categoryImageAspect')}
                    value={layout.sizing.categoryImageAspect}
                    options={['1:1', '3:4', '2:3']}
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

/**
 * Parse an aspect-ratio string like '2.45:1' / '3:4' / '16:9' into CSS
 * `aspect-ratio` value form (`w / h`). Used to render the live preview
 * rectangle inside SizingFieldWithPreview.
 */
function parseAspect(ratio: string): string {
  const [w, h] = ratio.split(':').map(Number);
  if (!w || !h || Number.isNaN(w) || Number.isNaN(h)) return '1 / 1';
  return `${w} / ${h}`;
}

/**
 * Sizing field with a live aspect-ratio preview rectangle. Solves the
 * 'I have no idea what 2.45:1 looks like' problem ahmad raised
 * 2026-05-16. The preview rectangle is bounded to a max 120px width
 * so heroes (wide) and product images (square) all fit consistently
 * in the form column.
 */
function SizingFieldWithPreview({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly string[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <SelectField label={label} value={value} options={options} onChange={onChange} />
      <div className="flex items-start gap-3">
        <div
          className="flex-shrink-0 rounded-md border border-dashed border-border bg-muted/50"
          style={{
            aspectRatio: parseAspect(value),
            width: '100%',
            maxWidth: 120,
          }}
          aria-hidden
        />
        <span className="text-xs text-muted-foreground pt-1 font-mono">{value}</span>
      </div>
    </div>
  );
}

function SectionTitleFields({
  title,
  titleAr,
  labelEn,
  labelAr,
  placeholderEn,
  placeholderAr,
  onChangeTitle,
  onChangeTitleAr,
}: {
  title: string | undefined;
  titleAr: string | undefined;
  labelEn: string;
  labelAr: string;
  placeholderEn: string;
  placeholderAr: string;
  onChangeTitle: (v: string) => void;
  onChangeTitleAr: (v: string) => void;
}) {
  return (
    <div className="mt-4 grid grid-cols-1 gap-3 border-t border-border pt-4 sm:grid-cols-2">
      <TextField
        label={labelEn}
        placeholder={placeholderEn}
        value={title ?? ''}
        onChange={onChangeTitle}
      />
      <TextField
        label={labelAr}
        placeholder={placeholderAr}
        value={titleAr ?? ''}
        onChange={onChangeTitleAr}
        dir="rtl"
      />
    </div>
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

/**
 * "Generate with AI" button used next to section content fields
 * (kicker + subtitle). Calls /ai/section-content + only fills empty
 * fields so a merchant's existing values aren't overwritten. Loading
 * state + success/error toast included.
 */
function AiSectionFillButton({
  storeId,
  section,
  existingTitle,
  existingTitleAr,
  onFilled,
}: {
  storeId: string;
  section: 'categories' | 'newArrivals' | 'bestSellers' | 'featured' | 'testimonials';
  existingTitle?: string;
  existingTitleAr?: string;
  onFilled: (r: { kicker: string; kickerAr: string; subtitle: string; subtitleAr: string }) => void;
}) {
  const [busy, setBusy] = useState(false);
  const { success: toastSuccess, error: toastError } = useToast();
  const generate = async () => {
    setBusy(true);
    try {
      const { data, error } = await apiPost<{
        suggestion: { kicker: string; kickerAr: string; subtitle: string; subtitleAr: string };
      }>(`/api/v1/stores/${storeId}/ai/section-content`, {
        section,
        existingTitle: existingTitle || undefined,
        existingTitleAr: existingTitleAr || undefined,
      });
      if (error || !data) {
        toastError('AI generation failed', error?.message ?? '');
        return;
      }
      onFilled(data.suggestion);
      toastSuccess('AI filled empty kicker + subtitle fields');
    } catch (e) {
      toastError('AI generation failed', e instanceof Error ? e.message : '');
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      onClick={generate}
      disabled={busy}
      className="inline-flex items-center gap-1.5 rounded-lg border border-primary/30 bg-primary/5 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/10 disabled:opacity-60 transition-colors cursor-pointer"
    >
      <svg
        className="h-3.5 w-3.5"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        aria-hidden
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"
        />
      </svg>
      {busy ? 'Generating…' : 'Generate with AI'}
    </button>
  );
}

interface SlidesEditorProps {
  slides: HeroSlide[];
  storeId: string;
  onChange: (next: HeroSlide[]) => void;
}

function SlidesEditor({ slides, storeId, onChange }: SlidesEditorProps) {
  const t = useT('orders.layout.sections.hero.slides');

  const updateSlide = (index: number, patch: Partial<HeroSlide>) => {
    onChange(slides.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  };

  const removeSlide = (index: number) => {
    onChange(slides.filter((_, i) => i !== index));
  };

  const moveSlide = (from: number, to: number) => {
    if (to < 0 || to >= slides.length) return;
    const next = [...slides];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    onChange(next);
  };

  const addSlide = () => {
    onChange([
      ...slides,
      { image: '', alt: '', headline: '', headlineAr: '', ctaText: '', ctaTextAr: '', ctaHref: '' },
    ]);
  };

  return (
    <div className="mt-4 space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-foreground">{t('title')}</h3>
        <p className="text-xs text-muted-foreground mt-0.5">{t('description')}</p>
      </div>

      {slides.length === 0 && (
        <p className="rounded-lg border border-dashed border-border bg-muted/30 p-4 text-center text-xs text-muted-foreground">
          {t('empty')}
        </p>
      )}

      <ul className="space-y-4">
        {slides.map((slide, index) => (
          <li key={index} className="rounded-xl border border-border bg-muted/20 p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <span className="text-sm font-semibold text-foreground">
                {t('slideLabel', { index: index + 1 })}
              </span>
              <div className="flex items-center gap-1">
                <IconButton
                  label={t('moveUp')}
                  disabled={index === 0}
                  onClick={() => moveSlide(index, index - 1)}
                >
                  <svg
                    className="h-4 w-4"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    aria-hidden
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M5 15l7-7 7 7"
                    />
                  </svg>
                </IconButton>
                <IconButton
                  label={t('moveDown')}
                  disabled={index === slides.length - 1}
                  onClick={() => moveSlide(index, index + 1)}
                >
                  <svg
                    className="h-4 w-4"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    aria-hidden
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M19 9l-7 7-7-7"
                    />
                  </svg>
                </IconButton>
                <IconButton label={t('remove')} variant="danger" onClick={() => removeSlide(index)}>
                  <svg
                    className="h-4 w-4"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    aria-hidden
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </svg>
                </IconButton>
              </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <div className="space-y-4">
                {/* Desktop image — wide cinematic crop */}
                <div className="rounded-xl border border-border bg-card p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <label className="text-xs font-semibold uppercase tracking-wider text-foreground">
                      {t('imageDesktop')}
                    </label>
                    <span className="text-[10px] text-muted-foreground">
                      {t('imageDesktopHint')}
                    </span>
                  </div>
                  <ImageUpload
                    value={slide.image || undefined}
                    folder="hero"
                    storeId={storeId}
                    onUpload={url => updateSlide(index, { image: url })}
                    onRemove={() => updateSlide(index, { image: '' })}
                  />
                  <div className="mt-3">
                    <label className="mb-1 block text-[10px] uppercase tracking-wider text-muted-foreground">
                      {t('imageDesktopAr')}
                    </label>
                    <ImageUpload
                      value={slide.imageAr || undefined}
                      folder="hero"
                      storeId={storeId}
                      onUpload={url => updateSlide(index, { imageAr: url })}
                      onRemove={() => updateSlide(index, { imageAr: '' })}
                    />
                  </div>
                </div>

                {/* Mobile image — taller crop, optional but recommended */}
                <div className="rounded-xl border border-border bg-card p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <label className="text-xs font-semibold uppercase tracking-wider text-foreground">
                      {t('imageMobile')}
                    </label>
                    <span className="text-[10px] text-muted-foreground">
                      {t('imageMobileHint')}
                    </span>
                  </div>
                  <ImageUpload
                    value={slide.imageMobile || undefined}
                    folder="hero"
                    storeId={storeId}
                    aspectRatio="3/4"
                    onUpload={url => updateSlide(index, { imageMobile: url })}
                    onRemove={() => updateSlide(index, { imageMobile: '' })}
                  />
                  <div className="mt-3">
                    <label className="mb-1 block text-[10px] uppercase tracking-wider text-muted-foreground">
                      {t('imageMobileAr')}
                    </label>
                    <ImageUpload
                      value={slide.imageMobileAr || undefined}
                      folder="hero"
                      storeId={storeId}
                      aspectRatio="3/4"
                      onUpload={url => updateSlide(index, { imageMobileAr: url })}
                      onRemove={() => updateSlide(index, { imageMobileAr: '' })}
                    />
                  </div>
                </div>
              </div>

              <div className="space-y-3">
                <TextField
                  label={t('alt')}
                  placeholder={t('altPlaceholder')}
                  value={slide.alt ?? ''}
                  onChange={v => updateSlide(index, { alt: v })}
                />
                <TextField
                  label={t('headline')}
                  placeholder={t('headlinePlaceholder')}
                  value={slide.headline ?? ''}
                  onChange={v => updateSlide(index, { headline: v })}
                />
                <TextField
                  label={t('headlineAr')}
                  placeholder={t('headlineArPlaceholder')}
                  value={slide.headlineAr ?? ''}
                  onChange={v => updateSlide(index, { headlineAr: v })}
                  dir="rtl"
                />
                <TextField
                  label={t('ctaText')}
                  placeholder={t('ctaTextPlaceholder')}
                  value={slide.ctaText ?? ''}
                  onChange={v => updateSlide(index, { ctaText: v })}
                />
                <TextField
                  label={t('ctaTextAr')}
                  placeholder={t('ctaTextArPlaceholder')}
                  value={slide.ctaTextAr ?? ''}
                  onChange={v => updateSlide(index, { ctaTextAr: v })}
                  dir="rtl"
                />
                <TextField
                  label={t('ctaHref')}
                  placeholder={t('ctaHrefPlaceholder')}
                  value={slide.ctaHref ?? ''}
                  onChange={v => updateSlide(index, { ctaHref: v })}
                />
              </div>
            </div>
          </li>
        ))}
      </ul>

      <button
        type="button"
        onClick={addSlide}
        className="inline-flex items-center gap-2 rounded-xl border border-dashed border-border bg-card px-4 py-2 text-sm font-medium text-foreground hover:bg-muted transition-colors cursor-pointer"
      >
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
        </svg>
        {t('add')}
      </button>
    </div>
  );
}

function TextField({
  label,
  value,
  placeholder,
  dir,
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  dir?: 'ltr' | 'rtl';
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        dir={dir}
        onChange={e => onChange(e.target.value)}
        className="rounded-lg border border-border bg-card px-3 py-2 text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
      />
    </label>
  );
}

function IconButton({
  label,
  disabled,
  variant = 'default',
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  variant?: 'default' | 'danger';
  onClick: () => void;
  children: React.ReactNode;
}) {
  const styles =
    variant === 'danger'
      ? 'border-destructive/40 text-destructive hover:bg-destructive/10'
      : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground';
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex h-8 w-8 items-center justify-center rounded-lg border transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${styles}`}
    >
      {children}
    </button>
  );
}
