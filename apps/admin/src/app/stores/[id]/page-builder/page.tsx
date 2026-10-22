'use client';

import { ModeButton } from './ModeButton';
import { CategoryLayoutButtons } from './CategoryLayoutButtons';
import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams } from 'next/navigation';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useToast } from '@ebda/ui';
import { useT } from '@/i18n/useT';
import {
  resolveLayoutSettings,
  DEFAULT_THEME,
  type StoreLayoutSettings,
  type ProductCardDefaults,
  type HeroSlide,
  recommendedSizeTextForTemplate,
  type TemplateId,
  type StoreTheme,
  type CardFrameSize,
  type CardFrameWidth,
  type ZoneOverride,
  type SectionTypographyOverride,
} from '@ebda/shared';

import { ColorField } from '../../../../components/ColorField';
import { ZoneEditor } from '../../../../components/ZoneEditor';
import { SmartPaletteModal, type ThemeUpdates } from '../../../../components/SmartPaletteModal';
import { SectionPreview } from '../../../../components/SectionPreview';
import { AdminLayout } from '../../../../components/AdminLayout';
import { Toggle } from '../../../../components/Toggle';
import {
  DividerStyleSelect,
  RowToggle,
  SectionDividersBlock,
  type KickerSubtitleValues,
} from '../../../../components/section-design/SectionDividersBlock';
import {
  ROLE_TO_GLOBAL_ZONE,
  SectionTypographyBlock,
  normalizeZoneColors,
  type SectionTypographyRole,
} from '../../../../components/section-design/SectionTypographyBlock';
import { FontsCard } from '../../../../components/section-design/FontsCard';
import { AiSectionFillButton } from '../../../../components/section-design/AiSectionFillButton';
import { ImageUpload } from '../../../../components/ImageUpload';
import { FooterLinksEditor } from '../../../../components/FooterLinksEditor';
import { NavMenuEditor } from '../../../../components/NavMenuEditor';
import { apiGet, apiPost, apiPut } from '../../../../lib/api';
import { loadPageRev, saveLayoutAsPage } from '../../../../lib/page-builder-save';
import { getStoreHref } from '../../../../lib/store-url';

interface StoreInfo {
  id: string;
  slug: string;
  domain?: string | null;
  /** Store template — used to resolve per-theme recommended upload sizes. */
  template?: TemplateId;
  /** Store theme — used by ColorField to resolve brand tokens for the contrast preview. */
  theme?: StoreTheme;
  /** Whether the /blog routes are enabled. Page-builder reads this as the
   *  legacy fallback for the blogCarousel.enabled toggle. */
  blogEnabled?: boolean;
}

// Neutral fallback used by SectionPreview before the real theme loads from the
// API. DEFAULT_THEME from @ebda/shared is the platform neutral; any token
// resolution will produce sensible greys + white until storeInfo arrives.
const FALLBACK_THEME: StoreTheme = DEFAULT_THEME;

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
  // Visual builder Phase 1: head rev of the homepage document — Save goes
  // through draft + publish naming it (409 on a concurrent edit). null = the
  // API has no builder routes yet; Save falls back to the legacy PUT.
  const [pageRev, setPageRev] = useState<number | null>(null);
  // Bumps after every successful Save so the live-preview iframe reloads.
  // The iframe `src` includes this as a query param — change → React re-renders
  // → iframe issues a fresh request → merchant sees their saved changes.
  const [previewRefreshTick, setPreviewRefreshTick] = useState(0);
  // Real-time draft token — when set, iframe loads ?_layoutDraft=<token>.
  // Storefront reads from Redis instead of the committed DB row, so merchant
  // sees pending changes without committing. Cleared on Save (saved version
  // becomes the source) or by clicking "Reset preview".
  const [previewDraftToken, setPreviewDraftToken] = useState<string | null>(null);
  const [isGeneratingPreview, setIsGeneratingPreview] = useState(false);
  // Preview device toggle. The preview pane sits in a ~480px grid column, an
  // in-between width BELOW the storefront's `sm` (640px) breakpoint — so a
  // `w-full` iframe renders the MOBILE hero asset at a non-phone width and
  // crops/shifts it (a real phone at 390px is fine). 'mobile' pins the iframe
  // to a true phone width (390px, centered); 'desktop' renders a wide canvas
  // (1280px) scaled to fit the pane so the desktop layout is shown un-cropped.
  // Preview was made mobile-only by Ahmad 2026-06-22 ("remove the desktop
  // preview, only mobile is great"). SUPERSEDED by Ruling BUILDER-PREVIEW-1
  // (Ahmad 2026-10-07): the builder previews desktop + tablet + mobile
  // (VIEWPORT_RANGES in @ebda/shared: 1280 / 820 / 390). The three-way switcher
  // ships with the new editor (Phase 2); this legacy page keeps its look in
  // Phase 1, pinned to a true phone width (390px) so the mobile hero renders
  // un-cropped.
  const previewDevice = 'mobile' as const;
  // Smart Palette + future brand-token edits stage their theme updates here
  // instead of writing immediately to /theme. The main Save button flushes
  // these alongside layout + typography so the merchant has one source of
  // truth for "is this saved?" and can discard with a page reload before
  // confirming. Ahmad 2026-05-20: "smart palette does apply automatically
  // i don't want this".
  const [pendingThemeUpdates, setPendingThemeUpdates] = useState<ThemeUpdates>({});
  // #1998 — staged value wins over the saved theme (same pattern as showQuickAdd).
  const saleBadgeLegacyCorner =
    pendingThemeUpdates.saleBadgeLegacyCorner ?? storeInfo?.theme?.saleBadgeLegacyCorner === true;
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Embedded editors (Navigation, Footer & utility links) register a silent
  // save here so the main Save button persists them — no separate save button,
  // no standalone page.
  const navSaveRef = useRef<(() => Promise<boolean>) | null>(null);
  const utilityBarSaveRef = useRef<(() => Promise<boolean>) | null>(null);
  const footerLinksSaveRef = useRef<(() => Promise<boolean>) | null>(null);
  // State refs — each editor keeps these current with its UNSAVED state so the
  // "Preview unsaved" POST can include nav/footer/utility in the draft bundle.
  const navStateRef = useRef<import('../../../../components/NavMenuEditor').NavItem[] | null>(null);
  // Two separate stateRefs: one for the utility-section instance (top utility bar)
  // and one for the links-section instance (footer columns). Both share the same
  // FooterLinksEditorState shape — we pick the relevant sub-keys from each.
  const utilityStateRef = useRef<
    import('../../../../components/FooterLinksEditor').FooterLinksEditorState | null
  >(null);
  const footerLinksStateRef = useRef<
    import('../../../../components/FooterLinksEditor').FooterLinksEditorState | null
  >(null);
  // Global typography zones — fetched from the same typography endpoint as
  // the standalone /typography page. Populated in fetchData and used as
  // (a) placeholder "inherit" hints in per-section ZoneEditors and
  // (b) editable values in the "Default typography" SectionCard.
  const [globalZones, setGlobalZones] = useState<Record<string, ZoneOverride>>({});
  // Font sources from the typography endpoint — preserved on save so we never
  // overwrite the merchant's custom/Google font library with an empty array
  // when only the zones are edited from this page.
  const [typographyFonts, setTypographyFonts] = useState<unknown[]>([]);

  // DRY handlers for the per-page "design" cards (Products list / Product detail
  // / Categories / Checkout / Cart). Each page settings object has the same
  // `{ bgColor?, typography? }` shape, so one set of handlers keyed by the
  // layout field name drives the ColorField + SectionTypographyBlock for all.
  type PageDesignKey =
    | 'productsPage'
    | 'productDetailPage'
    | 'categoriesPage'
    | 'locationsPage'
    | 'checkoutPage'
    | 'cartPage';
  const pageDesign = (key: PageDesignKey) => ({
    bgColor: (layout?.[key] as { bgColor?: string } | undefined)?.bgColor,
    colorScheme:
      (layout?.[key] as { colorScheme?: 'auto' | 'light' | 'dark' } | undefined)?.colorScheme ??
      'auto',
    density:
      (layout?.[key] as { density?: 'compact' | 'normal' | 'spacious' } | undefined)?.density ??
      'normal',
    textScale:
      (layout?.[key] as { textScale?: 'sm' | 'normal' | 'lg' | 'xl' } | undefined)?.textScale ??
      'normal',
    typography: (layout?.[key] as { typography?: SectionTypographyOverride } | undefined)
      ?.typography,
    onBg: (v: string) =>
      setLayout(prev => (prev ? { ...prev, [key]: { ...(prev[key] ?? {}), bgColor: v } } : prev)),
    onScheme: (v: 'auto' | 'light' | 'dark') =>
      setLayout(prev =>
        prev ? { ...prev, [key]: { ...(prev[key] ?? {}), colorScheme: v } } : prev
      ),
    onDensity: (v: 'compact' | 'normal' | 'spacious') =>
      setLayout(prev => (prev ? { ...prev, [key]: { ...(prev[key] ?? {}), density: v } } : prev)),
    onTextScale: (v: 'sm' | 'normal' | 'lg' | 'xl') =>
      setLayout(prev => (prev ? { ...prev, [key]: { ...(prev[key] ?? {}), textScale: v } } : prev)),
    onChangeRole: (role: SectionTypographyRole, next: Partial<ZoneOverride>) =>
      setLayout(prev => {
        if (!prev) return prev;
        const cur = (prev[key] ?? {}) as { typography?: SectionTypographyOverride };
        return {
          ...prev,
          [key]: {
            ...cur,
            typography: {
              ...(cur.typography ?? {}),
              [role]: { ...(cur.typography?.[role] ?? {}), ...next },
            },
          },
        };
      }),
    onResetRole: (role: SectionTypographyRole) =>
      setLayout(prev => {
        if (!prev) return prev;
        const cur = (prev[key] ?? {}) as { typography?: SectionTypographyOverride };
        const rest = { ...(cur.typography ?? {}) } as SectionTypographyOverride;
        delete rest[role];
        return { ...prev, [key]: { ...cur, typography: rest } };
      }),
    globalZonesFor: (roles: ReadonlyArray<SectionTypographyRole>) =>
      Object.fromEntries(roles.map(r => [r, globalZones[ROLE_TO_GLOBAL_ZONE[r]]])),
  });

  const fetchData = useCallback(async () => {
    if (!storeId) return;
    setIsLoading(true);
    try {
      // Typography endpoint returns { success: true, data: { typography: { fonts, zones } } }
      const [layoutRes, storeRes, typographyRes, rev] = await Promise.all([
        apiGet<{ layout: StoreLayoutSettings }>(`/api/v1/admin/stores/${storeId}/layout`),
        apiGet<{ store: StoreInfo }>(`/api/v1/admin/stores/${storeId}`),
        apiGet<{ typography: { fonts?: unknown[]; zones: Record<string, ZoneOverride> } }>(
          `/api/v1/stores/${storeId}/typography`
        ),
        loadPageRev(storeId),
      ]);
      setPageRev(rev);
      if (layoutRes.error) {
        toastError(t('loadError'));
      } else if (layoutRes.data?.layout) {
        setLayout(resolveLayoutSettings(layoutRes.data.layout));
      }
      if (storeRes.data?.store) {
        setStoreInfo(storeRes.data.store);
      }
      if (typographyRes.data?.typography) {
        // Preserve fonts so handleSave can round-trip them unchanged.
        setTypographyFonts(typographyRes.data.typography.fonts ?? []);

        if (typographyRes.data.typography.zones) {
          // Normalise legacy 'brand-*' color tokens to 'token:*' format so the
          // ColorField shows the correct chip instead of "Custom hex…".
          const raw = typographyRes.data.typography.zones;
          const normalized = Object.fromEntries(
            Object.entries(raw).map(([key, zone]) => [
              key,
              normalizeZoneColors(zone as ZoneOverride),
            ])
          );
          setGlobalZones(normalized);
        }
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

  // Layout save: builder draft + publish when the API has it (revisioned,
  // conflict-checked), else the legacy PUT. Resolves to the `{ error }`
  // shape the batch below already inspects.
  const saveLayout = async (current: StoreLayoutSettings) => {
    if (pageRev === null) return apiPut(`/api/v1/admin/stores/${storeId}/layout`, current);
    const r = await saveLayoutAsPage(storeId, current, pageRev);
    setPageRev(r.rev);
    return r.ok ? { data: undefined, error: null } : { data: undefined, error: r.error };
  };

  const handleSave = async () => {
    if (!layout) return;
    setIsSaving(true);
    try {
      // Build the parallel PUT batch. Theme updates only fire when the merchant
      // has staged some (Smart Palette apply, future brand-token edits) —
      // empty stage = skip the request entirely.
      const themeUpdateKeys = Object.keys(pendingThemeUpdates);
      const hasThemeUpdates = themeUpdateKeys.length > 0;
      // `PUT /theme` shallow-merges server-side: send ONLY the staged keys.
      // Re-sending the page-load snapshot would resurrect a key another
      // surface (look reset, Branding) removed since this page loaded.
      const themePromise = hasThemeUpdates
        ? apiPut(`/api/v1/stores/${storeId}/theme`, pendingThemeUpdates)
        : Promise.resolve({ data: undefined, error: undefined } as const);

      const [layoutResult, typographyResult, themeResult] = await Promise.allSettled([
        saveLayout(layout),
        apiPut(`/api/v1/stores/${storeId}/typography`, {
          fonts: typographyFonts,
          zones: globalZones,
        }),
        themePromise,
      ]);

      // Navigation, the top utility bar, and footer links are owned by embedded
      // editors that each GET-merge-PUT the store `settings` blob. They write
      // DIFFERENT keys (navMenu / utilityBar / footerLinks) but to the SAME
      // object — so they MUST run SEQUENTIALLY, or two parallel read-modify-write
      // round-trips would clobber each other. Editors surface their own error
      // toasts; a false/throw here is a non-fatal partial failure.
      try {
        if (navSaveRef.current) await navSaveRef.current();
        if (utilityBarSaveRef.current) await utilityBarSaveRef.current();
        if (footerLinksSaveRef.current) await footerLinksSaveRef.current();
      } catch {
        // Non-fatal — the editor already toasted.
      }

      const layoutFailed =
        layoutResult.status === 'rejected' ||
        (layoutResult.status === 'fulfilled' && !!layoutResult.value.error);
      const typographyFailed =
        typographyResult.status === 'rejected' ||
        (typographyResult.status === 'fulfilled' && !!typographyResult.value.error);
      const themeFailed =
        hasThemeUpdates &&
        (themeResult.status === 'rejected' ||
          (themeResult.status === 'fulfilled' && !!themeResult.value.error));

      const layoutConflict =
        layoutResult.status === 'fulfilled' && layoutResult.value.error?.code === 'REV_CONFLICT';

      if (layoutConflict) {
        // Another tab/editor saved the page since this one loaded: never
        // overwrite it silently — the merchant reloads and re-applies.
        toastError(t('saveConflict'));
      } else if (layoutFailed && typographyFailed) {
        toastError(t('saveError'));
      } else if (layoutFailed) {
        toastError(t('saveErrorLayoutOnly'));
      } else if (typographyFailed) {
        toastError(t('saveErrorTypographyOnly'));
      } else if (themeFailed) {
        toastError(
          'Brand colors save failed. Layout + typography saved successfully — re-apply brand colors in Smart Palette or /branding to retry.'
        );
      } else {
        toastSuccess(t('saved'));
        setPreviewRefreshTick(t => t + 1);
        // Saved layout is now authoritative — drop the draft token so the
        // iframe shows the committed version, not a stale preview.
        setPreviewDraftToken(null);
        // Clear pending theme updates only on successful save — otherwise the
        // merchant might assume they're saved when the request failed.
        if (hasThemeUpdates) {
          // Refresh storeInfo so subsequent ColorField "Brand: ..." picks
          // resolve to the freshly saved tokens.
          const storeRes = await apiGet<{ store: StoreInfo }>(`/api/v1/admin/stores/${storeId}`);
          if (storeRes.data?.store) {
            setStoreInfo(storeRes.data.store);
          }
          setPendingThemeUpdates({});
        }
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
        <div className="flex items-center gap-2">
          <a
            href={`/stores/${storeId}/builder`}
            className="inline-flex items-center gap-2 rounded-xl border border-primary/50 bg-primary/10 px-4 py-2 text-sm font-semibold text-foreground hover:bg-primary/20 transition-colors"
          >
            {t('toolbar.tryNewBuilder')}
          </a>
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="inline-flex items-center gap-2 rounded-xl border border-border bg-card px-4 py-2 text-sm font-semibold text-foreground hover:bg-muted transition-colors cursor-pointer"
          >
            {t('toolbar.smartPalette')}
          </button>
          {Object.keys(pendingThemeUpdates).length > 0 && (
            <span
              className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-700"
              title={t('toolbar.pendingBrandColorsHint')}
            >
              <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
              {t('toolbar.unsavedBrandColors')}
            </span>
          )}
          {/* Real-time preview — POSTs current local layout to Redis with a
              short-lived token, reloads iframe with ?_layoutDraft=<token>.
              Storefront renders the draft layout. Save commits permanently. */}
          <button
            type="button"
            disabled={!layout || isGeneratingPreview}
            onClick={async () => {
              if (!layout) return;
              setIsGeneratingPreview(true);
              try {
                // 2026-05-20: send the FULL preview bundle — layout +
                // typography (global fonts + per-zone overrides) + theme
                // (with any pending palette / card-flag updates merged in).
                // Without bundling, merchant tweaks to global zones or
                // theme didn't show in the iframe until Save committed.
                //
                // 2026-06-17: also include the current store.settings keys
                // (navMenu / footerLinks / utilityBar) so nav, footer links,
                // and the utility bar preview unsaved changes too. The state
                // refs are kept current by each embedded editor component.
                const themeForPreview = storeInfo?.theme
                  ? { ...storeInfo.theme, ...pendingThemeUpdates }
                  : pendingThemeUpdates;
                const draftSettings: Record<string, unknown> = {};
                if (navStateRef.current) {
                  draftSettings.navMenu = navStateRef.current;
                }
                // footerLinksStateRef covers the "links" section (shop/support/company columns).
                if (footerLinksStateRef.current) {
                  draftSettings.footerLinks = footerLinksStateRef.current.footerLinks;
                }
                // utilityStateRef covers the "utility" section (top bar links + enabled toggle).
                if (utilityStateRef.current) {
                  draftSettings.utilityBar = utilityStateRef.current.utilityBar;
                }
                const res = await apiPost<{ token: string }>(
                  `/api/v1/admin/stores/${storeId}/layout/preview`,
                  {
                    layout,
                    typography: { fonts: typographyFonts, zones: globalZones },
                    theme: themeForPreview,
                    ...(Object.keys(draftSettings).length > 0 ? { settings: draftSettings } : {}),
                  }
                );
                if (res.data?.token) {
                  setPreviewDraftToken(res.data.token);
                  setPreviewRefreshTick(t => t + 1);
                }
              } finally {
                setIsGeneratingPreview(false);
              }
            }}
            className="inline-flex items-center gap-2 rounded-xl border border-border bg-card px-4 py-2 text-sm font-semibold text-foreground hover:bg-muted transition-colors cursor-pointer disabled:opacity-60"
          >
            {isGeneratingPreview ? t('preview.generating') : `👁  ${t('preview.unsaved')}`}
          </button>
          {previewDraftToken && (
            <button
              type="button"
              onClick={() => {
                setPreviewDraftToken(null);
                setPreviewRefreshTick(t => t + 1);
              }}
              className="inline-flex items-center gap-1.5 rounded-full bg-sky-50 px-2.5 py-0.5 text-xs font-medium text-sky-700 hover:bg-sky-100"
              title={t('toolbar.stopPreviewHint')}
            >
              <span className="h-1.5 w-1.5 rounded-full bg-sky-500" />
              {t('toolbar.previewUnsavedChanges')}
            </button>
          )}
          <button
            type="button"
            onClick={handleSave}
            disabled={!layout || isSaving}
            className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60 transition-colors cursor-pointer"
          >
            {isSaving ? t('saving') : t('save')}
          </button>
        </div>
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
              {/* Expand / Collapse all — one-shot DOM-mutation approach.
                  React state per-card would be a much bigger refactor;
                  <details> is uncontrolled so we flip `details.open` directly. */}
              <div className="mb-1 flex items-center justify-end gap-2 text-xs">
                <button
                  type="button"
                  onClick={() => document.querySelectorAll('details').forEach(d => (d.open = true))}
                  className="text-muted-foreground hover:text-foreground underline"
                >
                  {t('toolbar.expandAll')}
                </button>
                <span className="text-muted-foreground">·</span>
                <button
                  type="button"
                  onClick={() =>
                    document.querySelectorAll('details').forEach(d => (d.open = false))
                  }
                  className="text-muted-foreground hover:text-foreground underline"
                >
                  {t('toolbar.collapseAll')}
                </button>
              </div>

              {/* Fonts — manage the font library the storefront pulls in.
                  Google Fonts add via family (URL auto-builds) + custom
                  font upload (.woff2/.woff/.ttf/.otf to R2 via /uploads/font). */}
              <FontsCard
                storeId={storeId}
                fonts={
                  typographyFonts as Array<{
                    type: 'google' | 'custom';
                    family: string;
                    url: string;
                    format?: string;
                  }>
                }
                onChange={next => setTypographyFonts(next)}
              />

              {/* Section order — drag-to-reorder ui (page-builder 2026-05-20).
                  Renders a sortable list of section keys; persists to
                  layout.sectionOrder. */}
              <SectionOrderCard
                order={layout.sectionOrder}
                onChange={next =>
                  setLayout(prev => (prev ? { ...prev, sectionOrder: next } : prev))
                }
              />

              {/* Hero — single image OR autoplay slider. The two modes share
                  the same slide list; "Static" pins to the first slide and
                  hides the autoplay control. */}
              <SectionCard
                title={t('sections.hero.title')}
                description={t('sections.hero.description')}
                enabled={layout.hero.enabled}
                onToggle={v => updateSection('hero', s => ({ ...s, enabled: v }))}
                defaultExpanded={false}
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
                {/* Image fit: full-bleed (crop to fill) vs framed (show the
                    whole image). A smaller-than-recommended image gets cropped
                    in full-bleed; framed (object-contain) shows it complete.
                    Default full-bleed preserves existing stores' look. */}
                <div className="mb-2 text-xs font-medium text-muted-foreground">
                  {t('sections.hero.fitLabel')}
                </div>
                <div className="grid grid-cols-3 gap-2 mb-2">
                  <ModeButton
                    active={(layout.hero.presentation ?? 'full-bleed') === 'full-bleed'}
                    onClick={() =>
                      updateSection('hero', s => ({ ...s, presentation: 'full-bleed' }))
                    }
                    label={t('sections.hero.fitFill')}
                  />
                  <ModeButton
                    active={layout.hero.presentation === 'framed'}
                    onClick={() => updateSection('hero', s => ({ ...s, presentation: 'framed' }))}
                    label={t('sections.hero.fitFit')}
                  />
                  <ModeButton
                    active={layout.hero.presentation === 'collage'}
                    onClick={() => updateSection('hero', s => ({ ...s, presentation: 'collage' }))}
                    label={t('sections.hero.fitCollage')}
                  />
                </div>
                <p className="mb-4 text-xs text-muted-foreground">
                  {layout.hero.presentation === 'collage'
                    ? t('sections.hero.fitCollageHint')
                    : (layout.hero.presentation ?? 'full-bleed') === 'full-bleed'
                      ? t('sections.hero.fitFillHint')
                      : t('sections.hero.fitFitHint')}
                </p>
                {/* Ruling B1-41: the opt-in hairline frame, offered only for a framed hero. */}
                {layout.hero.presentation === 'framed' && (
                  <>
                    <div className="mb-2 text-xs font-medium text-muted-foreground">
                      {t('sections.hero.frameLabel')}
                    </div>
                    <div className="grid grid-cols-2 gap-2 mb-4">
                      <ModeButton
                        active={(layout.hero.frame ?? 'none') === 'none'}
                        onClick={() => updateSection('hero', s => ({ ...s, frame: 'none' }))}
                        label={t('sections.hero.frameNone')}
                      />
                      <ModeButton
                        active={layout.hero.frame === 'line'}
                        onClick={() => updateSection('hero', s => ({ ...s, frame: 'line' }))}
                        label={t('sections.hero.frameLine')}
                      />
                    </div>
                  </>
                )}
                {/* W2a (L-04): where the copy sits. Bottom corner keeps the photo clear. */}
                {layout.hero.presentation !== 'collage' && (
                  <>
                    <div className="mb-2 text-xs font-medium text-muted-foreground">
                      {t('sections.hero.textAnchorLabel')}
                    </div>
                    <div className="grid grid-cols-2 gap-2 mb-4">
                      <ModeButton
                        active={(layout.hero.textAnchor ?? 'center') === 'center'}
                        onClick={() => updateSection('hero', s => ({ ...s, textAnchor: 'center' }))}
                        label={t('sections.hero.textAnchorCenter')}
                      />
                      <ModeButton
                        active={layout.hero.textAnchor === 'bottom-start'}
                        onClick={() =>
                          updateSection('hero', s => ({ ...s, textAnchor: 'bottom-start' }))
                        }
                        label={t('sections.hero.textAnchorBottomStart')}
                      />
                    </div>
                    {layout.hero.textAnchor === 'bottom-start' && (
                      <p className="-mt-2 mb-4 text-xs text-muted-foreground">
                        {t('sections.hero.textAnchorHint')}
                      </p>
                    )}
                  </>
                )}
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
                  storeTemplate={storeInfo?.template}
                  onChange={next => updateSection('hero', s => ({ ...s, slides: next }))}
                />
                <ColorField
                  label={t('common.sectionBgColorLabel')}
                  value={layout.hero.bgColor}
                  onChange={v => updateSection('hero', s => ({ ...s, bgColor: v }))}
                  hint={t('common.sectionBgColorHint')}
                  theme={storeInfo?.theme}
                  inheritFromToken="card"
                />
                {/* Per-section typography overrides — wins over the global zone for
                    this section only. Hero only exposes heading (heroHeadline global
                    zone is the placeholder). kicker/subtitle don't apply to hero. */}
                <SectionTypographyBlock
                  roles={['heading']}
                  typography={layout.hero.typography}
                  globalZones={{
                    heading: globalZones[ROLE_TO_GLOBAL_ZONE['heading']],
                  }}
                  onChangeRole={(role, next) =>
                    updateSection('hero', s => ({
                      ...s,
                      typography: {
                        ...(s.typography ?? {}),
                        [role]: { ...(s.typography?.[role] ?? {}), ...next },
                      },
                    }))
                  }
                  onResetRole={role =>
                    updateSection('hero', s => {
                      const rest = { ...(s.typography ?? {}) } as SectionTypographyOverride;
                      delete rest[role as keyof SectionTypographyOverride];
                      return {
                        ...s,
                        typography: Object.keys(rest).length ? rest : undefined,
                      };
                    })
                  }
                  theme={storeInfo?.theme}
                />
                <div className="mt-4">
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {t('preview.liveTitle')}
                  </p>
                  <SectionPreview
                    label={t('sectionLabels.hero')}
                    bgColor={layout.hero.bgColor}
                    cardFrameColor={undefined}
                    cardFrameWidth={undefined}
                    headingZone={layout.hero.typography?.heading}
                    kickerZone={layout.hero.typography?.kicker}
                    subtitleZone={layout.hero.typography?.subtitle}
                    dividers={layout.hero.dividers}
                    theme={storeInfo?.theme ?? FALLBACK_THEME}
                  />
                </div>
              </SectionCard>

              {/* Categories */}
              <SectionCard
                title={t('sections.categories.title')}
                description={t('sections.categories.description')}
                enabled={layout.categories.enabled}
                onToggle={v => updateSection('categories', s => ({ ...s, enabled: v }))}
                defaultExpanded={false}
              >
                {/* Desktop controls */}
                <p className="mt-2 mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {t('sections.categories.desktopLabel')}
                </p>
                <CategoryLayoutButtons
                  value={layout.categories.layout}
                  onChange={v => updateSection('categories', s => ({ ...s, layout: v }))}
                  t={t}
                />
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
                <CategoryLayoutButtons
                  value={layout.categories.layoutMobile ?? layout.categories.layout}
                  onChange={v => updateSection('categories', s => ({ ...s, layoutMobile: v }))}
                  t={t}
                />
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
                    2026-05-16. The two line-divider toggles below control
                    the editorial hairlines that flank the kicker/subtitle
                    text in the shared SectionHeading paths (products
                    carousel + horizontal-layout categories). Per-theme
                    grid-layout categories use a chip-style kicker that
                    doesn't have lines — toggles are a no-op there. */}
                <KickerSubtitleControls
                  storeId={storeId}
                  section="categories"
                  values={layout.categories}
                  onPatch={patch => updateSection('categories', s => ({ ...s, ...patch }))}
                  theme={storeInfo?.theme ?? FALLBACK_THEME}
                />
                {/* Card size, aspect, and visual toggles — Ahmad 2026-05-16
                    'make categories smaller + add options through admin'. */}
                {/* Card size / aspect / toggles — native selects with
                    descriptive labels (SelectField only accepts flat
                    string arrays). */}
                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="text-muted-foreground">{t('productCard.cardSize')}</span>
                    <select
                      value={layout.categories.cardSize ?? 'sm'}
                      onChange={e =>
                        updateSection('categories', s => ({
                          ...s,
                          cardSize: e.target.value as 'xxs' | 'xs' | 'sm' | 'md' | 'lg' | 'xl',
                        }))
                      }
                      className="rounded-lg border border-border bg-card px-3 py-2 text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                    >
                      <option value="xxs">{t('productCard.sizeTiniest')}</option>
                      <option value="xs">{t('productCard.sizeXs')}</option>
                      <option value="sm">{t('productCard.sizeSmDefault')}</option>
                      <option value="md">{t('productCard.sizeMd')}</option>
                      <option value="lg">{t('productCard.sizeLg')}</option>
                      <option value="xl">{t('productCard.sizeXl')}</option>
                    </select>
                  </label>
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="text-muted-foreground">{t('productCard.imageAspect')}</span>
                    <select
                      value={layout.categories.cardAspect ?? 'theme'}
                      onChange={e =>
                        updateSection('categories', s => ({
                          ...s,
                          cardAspect: e.target.value as
                            | 'theme'
                            | 'square'
                            | 'portrait'
                            | 'landscape'
                            | 'wide'
                            | 'ultrawide',
                        }))
                      }
                      className="rounded-lg border border-border bg-card px-3 py-2 text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                    >
                      <option value="theme">{t('productCard.aspectThemeDefaultRatio')}</option>
                      <option value="square">{t('productCard.aspectSquare')}</option>
                      <option value="portrait">{t('productCard.aspectPortraitRatio')}</option>
                      <option value="landscape">{t('productCard.aspectLandscapeRatio')}</option>
                      <option value="wide">{t('productCard.aspectWideRatio')}</option>
                      <option value="ultrawide">{t('productCard.aspectUltrawideRatio')}</option>
                    </select>
                  </label>
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="text-muted-foreground">{t('productCard.cardShape')}</span>
                    <select
                      value={layout.categories.cardShape ?? 'theme'}
                      onChange={e =>
                        updateSection('categories', s => ({
                          ...s,
                          cardShape: e.target.value as
                            | 'theme'
                            | 'circle'
                            | 'rounded-square'
                            | 'square'
                            | 'soft'
                            | 'portrait'
                            | 'landscape'
                            | 'pill',
                        }))
                      }
                      className="rounded-lg border border-border bg-card px-3 py-2 text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                    >
                      <option value="theme">{t('common.themeDefault')}</option>
                      <option value="circle">{t('productCard.shapeCircle')}</option>
                      <option value="rounded-square">{t('productCard.shapeRoundedSquare')}</option>
                      <option value="square">{t('productCard.shapeSharpSquare')}</option>
                      <option value="soft">{t('productCard.shapeSoftRectangle')}</option>
                      <option value="portrait">{t('productCard.shapePortraitPlain')}</option>
                      <option value="landscape">{t('productCard.shapeLandscapePlain')}</option>
                      <option value="pill">{t('productCard.shapePillRatio')}</option>
                    </select>
                    <span className="text-[11px] text-muted-foreground/80">
                      {t('productCard.shapeOverrideHint')}
                    </span>
                  </label>
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="text-muted-foreground">{t('productCard.cardSpacing')}</span>
                    <select
                      value={layout.categories.cardGap ?? 'normal'}
                      onChange={e =>
                        updateSection('categories', s => ({
                          ...s,
                          cardGap: e.target.value as 'tight' | 'normal' | 'loose' | 'xloose',
                        }))
                      }
                      className="rounded-lg border border-border bg-card px-3 py-2 text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                    >
                      <option value="tight">{t('productCard.spacingTight')}</option>
                      <option value="normal">{t('productCard.spacingNormalDefault')}</option>
                      <option value="loose">{t('productCard.spacingLoose')}</option>
                      <option value="xloose">{t('productCard.spacingXloose')}</option>
                    </select>
                  </label>
                  <RowToggle
                    label={t('productCard.showCategoryLabels')}
                    checked={layout.categories.showLabel !== false}
                    onChange={v => updateSection('categories', s => ({ ...s, showLabel: v }))}
                  />
                  <RowToggle
                    label={t('productCard.hoverEffects')}
                    checked={layout.categories.showHover !== false}
                    onChange={v => updateSection('categories', s => ({ ...s, showHover: v }))}
                  />
                  <RowToggle
                    label={t('productCard.showFrame')}
                    checked={!!layout.categories.showCardFrame}
                    onChange={v => updateSection('categories', s => ({ ...s, showCardFrame: v }))}
                  />
                  {layout.categories.showCardFrame && (
                    <label className="flex flex-col gap-1 text-sm">
                      <span className="text-muted-foreground">{t('productCard.frameStyle')}</span>
                      <select
                        value={layout.categories.cardFrameStyle ?? 'soft'}
                        onChange={e =>
                          updateSection('categories', s => ({
                            ...s,
                            cardFrameStyle: e.target.value as
                              | 'soft'
                              | 'outline'
                              | 'shadow'
                              | 'paper',
                          }))
                        }
                        className="rounded-lg border border-border bg-card px-3 py-2 text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                      >
                        <option value="soft">{t('productCard.frameSoftDefault')}</option>
                        <option value="outline">{t('productCard.frameOutline')}</option>
                        <option value="shadow">{t('productCard.frameShadow')}</option>
                        <option value="paper">{t('productCard.framePaper')}</option>
                      </select>
                    </label>
                  )}
                  {layout.categories.showCardFrame && (
                    <label className="flex flex-col gap-1 text-sm">
                      <span className="text-muted-foreground">
                        {t('productCard.borderThickness')}
                      </span>
                      <select
                        value={layout.categories.cardFrameWidth ?? 'thin'}
                        onChange={e =>
                          updateSection('categories', s => ({
                            ...s,
                            cardFrameWidth: e.target.value as CardFrameWidth,
                          }))
                        }
                        className="rounded-lg border border-border bg-card px-3 py-2 text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                      >
                        <option value="thin">{t('productCard.borderThinDefault')}</option>
                        <option value="normal">{t('productCard.borderNormal')}</option>
                        <option value="thick">{t('productCard.borderThick')}</option>
                        <option value="xthick">{t('productCard.borderXthick')}</option>
                      </select>
                    </label>
                  )}
                  {layout.categories.showCardFrame && (
                    <label className="flex flex-col gap-1 text-sm">
                      <span className="text-muted-foreground">{t('productCard.frameSize')}</span>
                      <select
                        value={layout.categories.cardFrameSize ?? 'normal'}
                        onChange={e =>
                          updateSection('categories', s => ({
                            ...s,
                            cardFrameSize: e.target.value as CardFrameSize,
                          }))
                        }
                        className="rounded-lg border border-border bg-card px-3 py-2 text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                      >
                        <option value="compact">{t('productCard.frameSizeCompact')}</option>
                        <option value="normal">{t('productCard.frameSizeNormalDefault')}</option>
                        <option value="comfortable">{t('productCard.frameSizeComfortable')}</option>
                        <option value="spacious">{t('productCard.frameSizeSpacious')}</option>
                      </select>
                    </label>
                  )}
                </div>
                {layout.categories.showCardFrame && (
                  <ColorField
                    label={t('productCard.frameColorLabel')}
                    value={layout.categories.cardFrameColor}
                    onChange={v => updateSection('categories', s => ({ ...s, cardFrameColor: v }))}
                    hint={t('categories.frameColorHint')}
                    theme={storeInfo?.theme}
                    inheritFromToken="border"
                  />
                )}
                <ColorField
                  label={t('common.sectionBgColorLabel')}
                  value={layout.categories.bgColor}
                  onChange={v => updateSection('categories', s => ({ ...s, bgColor: v }))}
                  hint={t('common.sectionBgColorHint')}
                  theme={storeInfo?.theme}
                  inheritFromToken="card"
                />
                <SectionTypographyBlock
                  roles={['heading', 'kicker', 'subtitle', 'seeAll', 'categoryLabel']}
                  typography={layout.categories.typography}
                  globalZones={Object.fromEntries(
                    (['heading', 'kicker', 'subtitle', 'seeAll', 'categoryLabel'] as const).map(
                      r => [r, globalZones[ROLE_TO_GLOBAL_ZONE[r]]]
                    )
                  )}
                  onChangeRole={(role, next) =>
                    updateSection('categories', s => ({
                      ...s,
                      typography: {
                        ...(s.typography ?? {}),
                        [role]: { ...(s.typography?.[role] ?? {}), ...next },
                      },
                    }))
                  }
                  onResetRole={role =>
                    updateSection('categories', s => {
                      const rest = { ...(s.typography ?? {}) } as SectionTypographyOverride;
                      delete rest[role as keyof SectionTypographyOverride];
                      return {
                        ...s,
                        typography: Object.keys(rest).length ? rest : undefined,
                      };
                    })
                  }
                  theme={storeInfo?.theme}
                />
                <div className="mt-4">
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {t('preview.liveTitle')}
                  </p>
                  <SectionPreview
                    label={t('sectionLabels.categories')}
                    bgColor={layout.categories.bgColor}
                    cardFrameColor={layout.categories.cardFrameColor}
                    cardFrameWidth={layout.categories.cardFrameWidth}
                    cardFrameSize={layout.categories.cardFrameSize}
                    headingZone={layout.categories.typography?.heading}
                    kickerZone={layout.categories.typography?.kicker}
                    subtitleZone={layout.categories.typography?.subtitle}
                    titleText={layout.categories.title}
                    kickerText={layout.categories.kicker}
                    subtitleText={layout.categories.subtitle}
                    dividers={layout.categories.dividers}
                    theme={storeInfo?.theme ?? FALLBACK_THEME}
                  />
                </div>
              </SectionCard>

              {/* New arrivals */}
              <SectionCard
                title={t('sections.newArrivals.title')}
                description={t('sections.newArrivals.description')}
                enabled={layout.newArrivals.enabled}
                onToggle={v => updateSection('newArrivals', s => ({ ...s, enabled: v }))}
                defaultExpanded={false}
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
                <KickerSubtitleControls
                  storeId={storeId}
                  section="newArrivals"
                  values={layout.newArrivals}
                  onPatch={patch => updateSection('newArrivals', s => ({ ...s, ...patch }))}
                  theme={storeInfo?.theme ?? FALLBACK_THEME}
                />
                <ProductCardControls
                  values={layout.newArrivals}
                  onChange={patch => updateSection('newArrivals', s => ({ ...s, ...patch }))}
                  theme={storeInfo?.theme}
                />
                <ColorField
                  label={t('common.sectionBgColorLabel')}
                  value={layout.newArrivals.bgColor}
                  onChange={v => updateSection('newArrivals', s => ({ ...s, bgColor: v }))}
                  hint={t('common.sectionBgColorHint')}
                  theme={storeInfo?.theme}
                  inheritFromToken="card"
                />
                <SectionTypographyBlock
                  roles={[
                    'heading',
                    'kicker',
                    'subtitle',
                    'seeAll',
                    'productName',
                    'productPrice',
                    'productCta',
                  ]}
                  typography={layout.newArrivals.typography}
                  globalZones={Object.fromEntries(
                    (
                      [
                        'heading',
                        'kicker',
                        'subtitle',
                        'seeAll',
                        'productName',
                        'productPrice',
                        'productCta',
                      ] as const
                    ).map(r => [r, globalZones[ROLE_TO_GLOBAL_ZONE[r]]])
                  )}
                  onChangeRole={(role, next) =>
                    updateSection('newArrivals', s => ({
                      ...s,
                      typography: {
                        ...(s.typography ?? {}),
                        [role]: { ...(s.typography?.[role] ?? {}), ...next },
                      },
                    }))
                  }
                  onResetRole={role =>
                    updateSection('newArrivals', s => {
                      const rest = { ...(s.typography ?? {}) } as SectionTypographyOverride;
                      delete rest[role as keyof SectionTypographyOverride];
                      return {
                        ...s,
                        typography: Object.keys(rest).length ? rest : undefined,
                      };
                    })
                  }
                  theme={storeInfo?.theme}
                />
                <div className="mt-4">
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {t('preview.liveTitle')}
                  </p>
                  <SectionPreview
                    label={t('sectionLabels.newArrivals')}
                    bgColor={layout.newArrivals.bgColor}
                    cardFrameColor={layout.newArrivals.cardFrameColor}
                    cardFrameWidth={layout.newArrivals.cardFrameWidth}
                    cardFrameSize={layout.newArrivals.cardFrameSize}
                    headingZone={layout.newArrivals.typography?.heading}
                    kickerZone={layout.newArrivals.typography?.kicker}
                    subtitleZone={layout.newArrivals.typography?.subtitle}
                    titleText={layout.newArrivals.title}
                    kickerText={layout.newArrivals.kicker}
                    subtitleText={layout.newArrivals.subtitle}
                    dividers={layout.newArrivals.dividers}
                    theme={storeInfo?.theme ?? FALLBACK_THEME}
                  />
                </div>
              </SectionCard>

              {/* Best sellers */}
              <SectionCard
                title={t('sections.bestSellers.title')}
                description={t('sections.bestSellers.description')}
                enabled={layout.bestSellers.enabled}
                onToggle={v => updateSection('bestSellers', s => ({ ...s, enabled: v }))}
                defaultExpanded={false}
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
                <KickerSubtitleControls
                  storeId={storeId}
                  section="bestSellers"
                  values={layout.bestSellers}
                  onPatch={patch => updateSection('bestSellers', s => ({ ...s, ...patch }))}
                  theme={storeInfo?.theme ?? FALLBACK_THEME}
                />
                <ProductCardControls
                  values={layout.bestSellers}
                  onChange={patch => updateSection('bestSellers', s => ({ ...s, ...patch }))}
                  theme={storeInfo?.theme}
                />
                <ColorField
                  label={t('common.sectionBgColorLabel')}
                  value={layout.bestSellers.bgColor}
                  onChange={v => updateSection('bestSellers', s => ({ ...s, bgColor: v }))}
                  hint={t('common.sectionBgColorHint')}
                  theme={storeInfo?.theme}
                  inheritFromToken="card"
                />
                <SectionTypographyBlock
                  roles={[
                    'heading',
                    'kicker',
                    'subtitle',
                    'seeAll',
                    'productName',
                    'productPrice',
                    'productCta',
                  ]}
                  typography={layout.bestSellers.typography}
                  globalZones={Object.fromEntries(
                    (
                      [
                        'heading',
                        'kicker',
                        'subtitle',
                        'seeAll',
                        'productName',
                        'productPrice',
                        'productCta',
                      ] as const
                    ).map(r => [r, globalZones[ROLE_TO_GLOBAL_ZONE[r]]])
                  )}
                  onChangeRole={(role, next) =>
                    updateSection('bestSellers', s => ({
                      ...s,
                      typography: {
                        ...(s.typography ?? {}),
                        [role]: { ...(s.typography?.[role] ?? {}), ...next },
                      },
                    }))
                  }
                  onResetRole={role =>
                    updateSection('bestSellers', s => {
                      const rest = { ...(s.typography ?? {}) } as SectionTypographyOverride;
                      delete rest[role as keyof SectionTypographyOverride];
                      return {
                        ...s,
                        typography: Object.keys(rest).length ? rest : undefined,
                      };
                    })
                  }
                  theme={storeInfo?.theme}
                />
                <div className="mt-4">
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {t('preview.liveTitle')}
                  </p>
                  <SectionPreview
                    label={t('sectionLabels.bestSellers')}
                    bgColor={layout.bestSellers.bgColor}
                    cardFrameColor={layout.bestSellers.cardFrameColor}
                    cardFrameWidth={layout.bestSellers.cardFrameWidth}
                    cardFrameSize={layout.bestSellers.cardFrameSize}
                    headingZone={layout.bestSellers.typography?.heading}
                    kickerZone={layout.bestSellers.typography?.kicker}
                    subtitleZone={layout.bestSellers.typography?.subtitle}
                    titleText={layout.bestSellers.title}
                    kickerText={layout.bestSellers.kicker}
                    subtitleText={layout.bestSellers.subtitle}
                    dividers={layout.bestSellers.dividers}
                    theme={storeInfo?.theme ?? FALLBACK_THEME}
                  />
                </div>
              </SectionCard>

              {/* Filter sidebar */}
              <SectionCard
                title={t('sections.filterSidebar.title')}
                description={t('sections.filterSidebar.description')}
                enabled={layout.filterSidebar.enabled}
                onToggle={v => updateSection('filterSidebar', s => ({ ...s, enabled: v }))}
                defaultExpanded={false}
              >
                <RowToggle
                  label={t('sections.filterSidebar.defaultOpen')}
                  checked={layout.filterSidebar.defaultOpen}
                  onChange={v => updateSection('filterSidebar', s => ({ ...s, defaultOpen: v }))}
                />
                <ColorField
                  label={t('sections.filterSidebar.bgColor')}
                  value={layout.filterSidebar.bgColor}
                  onChange={v =>
                    updateSection('filterSidebar', s => ({ ...s, bgColor: v ?? undefined }))
                  }
                  theme={storeInfo?.theme}
                />
                <ColorField
                  label={t('sections.filterSidebar.textColor')}
                  value={layout.filterSidebar.textColor}
                  onChange={v =>
                    updateSection('filterSidebar', s => ({ ...s, textColor: v ?? undefined }))
                  }
                  theme={storeInfo?.theme}
                />
              </SectionCard>

              {/* ── Page design: one card per storefront page (background +
                  typography). Each uses the shared pageDesign() handlers so they
                  behave identically. "Product cards (everywhere)" below is the
                  separate cross-page CARD styling. ── */}

              {/* Products list page (/products) */}
              {(() => {
                const pg = pageDesign('productsPage');
                const roles = ['heading', 'subtitle'] as const;
                return (
                  <SectionCard
                    title={t('pageCards.productsListTitle')}
                    description={t('pageCards.productsListDescription')}
                    defaultExpanded={false}
                    alwaysOn
                  >
                    <ColorField
                      label={t('pageCards.backgroundLabel')}
                      value={pg.bgColor}
                      onChange={pg.onBg}
                      theme={storeInfo?.theme}
                    />
                    <SchemeSelect value={pg.colorScheme} onChange={pg.onScheme} />
                    <DensitySelect value={pg.density} onChange={pg.onDensity} />
                    <TextScaleSelect value={pg.textScale} onChange={pg.onTextScale} />
                    <SectionTypographyBlock
                      roles={roles}
                      typography={pg.typography}
                      globalZones={pg.globalZonesFor(roles)}
                      onChangeRole={pg.onChangeRole}
                      onResetRole={pg.onResetRole}
                      theme={storeInfo?.theme}
                    />
                    {/* PLP text color knobs — breadcrumb, h1, subtitle.
                        Stored on StoreTheme JSON (no migration). */}
                    <div className="mt-4 space-y-1 border-t border-border/40 pt-4">
                      <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        {t('pageCards.textColorsTitle')}
                      </p>
                      <ColorField
                        label={t('pageCards.breadcrumbColorLabel')}
                        value={
                          (pendingThemeUpdates.plpBreadcrumbColor as string | undefined) ??
                          storeInfo?.theme?.plpBreadcrumbColor
                        }
                        onChange={v =>
                          setPendingThemeUpdates(prev => ({ ...prev, plpBreadcrumbColor: v }))
                        }
                        hint={t('pageCards.breadcrumbColorHint')}
                        theme={storeInfo?.theme ?? FALLBACK_THEME}
                        inheritFromToken="muted"
                      />
                      <ColorField
                        label={t('pageCards.headingColorLabel')}
                        value={
                          (pendingThemeUpdates.plpHeadingColor as string | undefined) ??
                          storeInfo?.theme?.plpHeadingColor
                        }
                        onChange={v =>
                          setPendingThemeUpdates(prev => ({ ...prev, plpHeadingColor: v }))
                        }
                        hint={t('pageCards.headingColorHint')}
                        theme={storeInfo?.theme ?? FALLBACK_THEME}
                        inheritFromToken="foreground"
                      />
                      <ColorField
                        label={t('pageCards.subtitleColorLabel')}
                        value={
                          (pendingThemeUpdates.plpSubheadingColor as string | undefined) ??
                          storeInfo?.theme?.plpSubheadingColor
                        }
                        onChange={v =>
                          setPendingThemeUpdates(prev => ({ ...prev, plpSubheadingColor: v }))
                        }
                        hint={t('pageCards.subtitleColorHint')}
                        theme={storeInfo?.theme ?? FALLBACK_THEME}
                        inheritFromToken="muted"
                      />
                    </div>
                  </SectionCard>
                );
              })()}

              {/* Product detail page (/products/[slug]) */}
              {(() => {
                const pg = pageDesign('productDetailPage');
                const roles = ['heading', 'productName', 'productPrice'] as const;
                return (
                  <SectionCard
                    title={t('pageCards.productDetailTitle')}
                    description={t('pageCards.productDetailDescription')}
                    defaultExpanded={false}
                    alwaysOn
                  >
                    <ColorField
                      label={t('pageCards.backgroundLabel')}
                      value={pg.bgColor}
                      onChange={pg.onBg}
                      theme={storeInfo?.theme}
                    />
                    <SchemeSelect value={pg.colorScheme} onChange={pg.onScheme} />
                    <DensitySelect value={pg.density} onChange={pg.onDensity} />
                    <TextScaleSelect value={pg.textScale} onChange={pg.onTextScale} />
                    <label className="flex flex-col gap-1">
                      <span className="text-xs font-medium text-muted-foreground">
                        {t('pageCards.mainImageAspectLabel')}
                      </span>
                      <select
                        value={layout.productDetailPage?.imageAspect ?? 'auto'}
                        onChange={e =>
                          setLayout(prev =>
                            prev
                              ? {
                                  ...prev,
                                  productDetailPage: {
                                    ...(prev.productDetailPage ?? {}),
                                    imageAspect: e.target.value as
                                      | 'auto'
                                      | 'square'
                                      | 'portrait'
                                      | 'landscape'
                                      | 'wide'
                                      | 'ultrawide',
                                  },
                                }
                              : prev
                          )
                        }
                        className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
                      >
                        <option value="auto">{t('productCard.aspectAutoSquare')}</option>
                        <option value="square">{t('productCard.aspectSquarePlain')}</option>
                        <option value="portrait">{t('productCard.shapePortraitPlain')}</option>
                        <option value="landscape">{t('productCard.shapeLandscapePlain')}</option>
                        <option value="wide">{t('productCard.aspectWidePlain')}</option>
                        <option value="ultrawide">{t('productCard.aspectUltrawidePlain')}</option>
                      </select>
                    </label>
                    <SectionTypographyBlock
                      roles={roles}
                      typography={pg.typography}
                      globalZones={pg.globalZonesFor(roles)}
                      onChangeRole={pg.onChangeRole}
                      onResetRole={pg.onResetRole}
                      theme={storeInfo?.theme}
                    />
                  </SectionCard>
                );
              })()}

              {/* Categories page (/categories) */}
              {(() => {
                const pg = pageDesign('categoriesPage');
                const roles = ['heading', 'subtitle', 'categoryLabel'] as const;
                return (
                  <SectionCard
                    title={t('pageCards.categoriesTitle')}
                    description={t('pageCards.categoriesDescription')}
                    defaultExpanded={false}
                    alwaysOn
                  >
                    <ColorField
                      label={t('pageCards.backgroundLabel')}
                      value={pg.bgColor}
                      onChange={pg.onBg}
                      theme={storeInfo?.theme}
                    />
                    <SchemeSelect value={pg.colorScheme} onChange={pg.onScheme} />
                    <DensitySelect value={pg.density} onChange={pg.onDensity} />
                    <TextScaleSelect value={pg.textScale} onChange={pg.onTextScale} />
                    <SectionTypographyBlock
                      roles={roles}
                      typography={pg.typography}
                      globalZones={pg.globalZonesFor(roles)}
                      onChangeRole={pg.onChangeRole}
                      onResetRole={pg.onResetRole}
                      theme={storeInfo?.theme}
                    />
                  </SectionCard>
                );
              })()}

              {/* Locations page (/locations) */}
              {(() => {
                const pg = pageDesign('locationsPage');
                const roles = ['heading', 'subtitle'] as const;
                return (
                  <SectionCard
                    title={t('pageCards.locationsTitle')}
                    description={t('pageCards.locationsDescription')}
                    defaultExpanded={false}
                    alwaysOn
                  >
                    <ColorField
                      label={t('pageCards.backgroundLabel')}
                      value={pg.bgColor}
                      onChange={pg.onBg}
                      theme={storeInfo?.theme}
                    />
                    <SchemeSelect value={pg.colorScheme} onChange={pg.onScheme} />
                    <DensitySelect value={pg.density} onChange={pg.onDensity} />
                    <TextScaleSelect value={pg.textScale} onChange={pg.onTextScale} />
                    <SectionTypographyBlock
                      roles={roles}
                      typography={pg.typography}
                      globalZones={pg.globalZonesFor(roles)}
                      onChangeRole={pg.onChangeRole}
                      onResetRole={pg.onResetRole}
                      theme={storeInfo?.theme}
                    />
                  </SectionCard>
                );
              })()}

              {/* Checkout / payment page (/checkout) */}
              {(() => {
                const pg = pageDesign('checkoutPage');
                const roles = ['heading', 'subtitle', 'productPrice'] as const;
                return (
                  <SectionCard
                    title={t('pageCards.checkoutTitle')}
                    description={t('pageCards.checkoutDescription')}
                    defaultExpanded={false}
                    alwaysOn
                  >
                    <ColorField
                      label={t('pageCards.backgroundLabel')}
                      value={pg.bgColor}
                      onChange={pg.onBg}
                      theme={storeInfo?.theme}
                    />
                    <SchemeSelect value={pg.colorScheme} onChange={pg.onScheme} />
                    <DensitySelect value={pg.density} onChange={pg.onDensity} />
                    <TextScaleSelect value={pg.textScale} onChange={pg.onTextScale} />
                    <SectionTypographyBlock
                      roles={roles}
                      typography={pg.typography}
                      globalZones={pg.globalZonesFor(roles)}
                      onChangeRole={pg.onChangeRole}
                      onResetRole={pg.onResetRole}
                      theme={storeInfo?.theme}
                    />
                  </SectionCard>
                );
              })()}

              {/* Cart page — standalone background + typography control. Saved
                  via the main page-builder save button (no separate save / page). */}
              <SectionCard
                title={t('pageCards.cartTitle')}
                description={t('pageCards.cartDescription')}
                defaultExpanded={false}
                alwaysOn
              >
                <ColorField
                  label={t('pageCards.backgroundLabel')}
                  value={layout.cartPage?.bgColor}
                  onChange={v =>
                    setLayout(prev =>
                      prev
                        ? {
                            ...prev,
                            cartPage: { ...(prev.cartPage ?? {}), bgColor: v },
                          }
                        : prev
                    )
                  }
                  theme={storeInfo?.theme}
                />
                <SchemeSelect
                  value={layout.cartPage?.colorScheme ?? 'auto'}
                  onChange={v =>
                    setLayout(prev =>
                      prev
                        ? { ...prev, cartPage: { ...(prev.cartPage ?? {}), colorScheme: v } }
                        : prev
                    )
                  }
                />
                <DensitySelect
                  value={layout.cartPage?.density ?? 'normal'}
                  onChange={v =>
                    setLayout(prev =>
                      prev ? { ...prev, cartPage: { ...(prev.cartPage ?? {}), density: v } } : prev
                    )
                  }
                />
                <TextScaleSelect
                  value={layout.cartPage?.textScale ?? 'normal'}
                  onChange={v =>
                    setLayout(prev =>
                      prev
                        ? { ...prev, cartPage: { ...(prev.cartPage ?? {}), textScale: v } }
                        : prev
                    )
                  }
                />
                <SectionTypographyBlock
                  roles={['heading', 'subtitle', 'productName', 'productPrice', 'productCta']}
                  typography={layout.cartPage?.typography}
                  globalZones={Object.fromEntries(
                    (
                      ['heading', 'subtitle', 'productName', 'productPrice', 'productCta'] as const
                    ).map(r => [r, globalZones[ROLE_TO_GLOBAL_ZONE[r]]])
                  )}
                  onChangeRole={(role, next) =>
                    setLayout(prev =>
                      prev
                        ? {
                            ...prev,
                            cartPage: {
                              ...(prev.cartPage ?? {}),
                              typography: {
                                ...(prev.cartPage?.typography ?? {}),
                                [role]: {
                                  ...(prev.cartPage?.typography?.[
                                    role as keyof SectionTypographyOverride
                                  ] ?? {}),
                                  ...next,
                                },
                              },
                            },
                          }
                        : prev
                    )
                  }
                  onResetRole={role =>
                    setLayout(prev => {
                      if (!prev) return prev;
                      const rest = {
                        ...(prev.cartPage?.typography ?? {}),
                      } as SectionTypographyOverride;
                      delete rest[role as keyof SectionTypographyOverride];
                      return {
                        ...prev,
                        cartPage: { ...(prev.cartPage ?? {}), typography: rest },
                      };
                    })
                  }
                  theme={storeInfo?.theme}
                />
                {/* Order-summary label colors — cart, checkout, and address pages.
                    Stored on StoreTheme JSON (no migration). Defaults match the
                    current look so existing stores see no visual change. */}
                <div className="mt-4 space-y-1 border-t border-border/40 pt-4">
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {t('pageCards.orderSummaryLabelsTitle')}
                  </p>
                  <ColorField
                    label={t('pageCards.labelColorLabel')}
                    value={
                      (pendingThemeUpdates.summaryLabelColor as string | undefined) ??
                      storeInfo?.theme?.summaryLabelColor
                    }
                    onChange={v =>
                      setPendingThemeUpdates(prev => ({ ...prev, summaryLabelColor: v }))
                    }
                    hint={t('pageCards.labelColorHint')}
                    theme={storeInfo?.theme ?? FALLBACK_THEME}
                    inheritFromToken="foreground"
                  />
                  <ColorField
                    label={t('pageCards.totalColorLabel')}
                    value={
                      (pendingThemeUpdates.summaryTotalColor as string | undefined) ??
                      storeInfo?.theme?.summaryTotalColor
                    }
                    onChange={v =>
                      setPendingThemeUpdates(prev => ({ ...prev, summaryTotalColor: v }))
                    }
                    hint={t('pageCards.totalColorHint')}
                    theme={storeInfo?.theme ?? FALLBACK_THEME}
                    inheritFromToken="foreground"
                  />
                  <label className="flex items-center justify-between gap-4 rounded-lg border border-border bg-card p-4 cursor-pointer">
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm font-semibold text-foreground">
                        {t('pageCards.boldSummaryLabels')}
                      </span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {t('pageCards.boldSummaryLabelsHint')}
                      </span>
                    </span>
                    <input
                      type="checkbox"
                      checked={
                        pendingThemeUpdates.summaryLabelBold !== undefined
                          ? (pendingThemeUpdates.summaryLabelBold as boolean)
                          : storeInfo?.theme?.summaryLabelBold !== false
                      }
                      onChange={e =>
                        setPendingThemeUpdates(prev => ({
                          ...prev,
                          summaryLabelBold: e.target.checked,
                        }))
                      }
                      className="h-5 w-5 cursor-pointer accent-primary"
                    />
                  </label>
                  {/* #2349 — per-store StoreTheme flag (shallow-merge theme PATCH on
                      Save, via pendingThemeUpdates). Off = readable -ink message
                      colours; on = the legacy bare role colours. */}
                  <label className="flex items-center justify-between gap-4 rounded-lg border border-border bg-card p-4 cursor-pointer">
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm font-semibold text-foreground">
                        {t('pageCards.legacyBannerContrastTitle')}
                      </span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {t('pageCards.legacyBannerContrastHint')}
                      </span>
                    </span>
                    <input
                      type="checkbox"
                      checked={
                        pendingThemeUpdates.legacyBannerContrast ??
                        storeInfo?.theme?.legacyBannerContrast === true
                      }
                      onChange={e =>
                        setPendingThemeUpdates(prev => ({
                          ...prev,
                          legacyBannerContrast: e.target.checked,
                        }))
                      }
                      className="h-5 w-5 cursor-pointer accent-primary"
                    />
                  </label>
                </div>
              </SectionCard>

              {/* Testimonials */}
              <SectionCard
                title={t('sections.testimonials.title')}
                description={t('sections.testimonials.description')}
                enabled={layout.testimonials.enabled}
                onToggle={v => updateSection('testimonials', s => ({ ...s, enabled: v }))}
                defaultExpanded={false}
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
                <ColorField
                  label={t('common.sectionBgColorLabel')}
                  value={layout.testimonials.bgColor}
                  onChange={v => updateSection('testimonials', s => ({ ...s, bgColor: v }))}
                  hint={t('common.sectionBgColorHint')}
                  theme={storeInfo?.theme}
                  inheritFromToken="card"
                />
                <SectionTypographyBlock
                  roles={['heading', 'kicker', 'subtitle']}
                  typography={layout.testimonials.typography}
                  globalZones={Object.fromEntries(
                    (['heading', 'kicker', 'subtitle'] as const).map(r => [
                      r,
                      globalZones[ROLE_TO_GLOBAL_ZONE[r]],
                    ])
                  )}
                  onChangeRole={(role, next) =>
                    updateSection('testimonials', s => ({
                      ...s,
                      typography: {
                        ...(s.typography ?? {}),
                        [role]: { ...(s.typography?.[role] ?? {}), ...next },
                      },
                    }))
                  }
                  onResetRole={role =>
                    updateSection('testimonials', s => {
                      const rest = { ...(s.typography ?? {}) } as SectionTypographyOverride;
                      delete rest[role as keyof SectionTypographyOverride];
                      return {
                        ...s,
                        typography: Object.keys(rest).length ? rest : undefined,
                      };
                    })
                  }
                  theme={storeInfo?.theme}
                />
                <div className="mt-4">
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {t('preview.liveTitle')}
                  </p>
                  <SectionPreview
                    label={t('sectionLabels.testimonials')}
                    bgColor={layout.testimonials.bgColor}
                    cardFrameColor={undefined}
                    cardFrameWidth={undefined}
                    headingZone={layout.testimonials.typography?.heading}
                    kickerZone={layout.testimonials.typography?.kicker}
                    subtitleZone={layout.testimonials.typography?.subtitle}
                    titleText={layout.testimonials.title}
                    dividers={layout.testimonials.dividers}
                    theme={storeInfo?.theme ?? FALLBACK_THEME}
                  />
                </div>
              </SectionCard>

              {/* Product reviews (sibling of testimonials — both UGC) */}
              <SectionCard
                title={t('sections.reviewSection.title')}
                description={t('sections.reviewSection.description')}
                enabled={layout.reviewSection.enabled}
                onToggle={v => updateSection('reviewSection', s => ({ ...s, enabled: v }))}
                defaultExpanded={false}
              ></SectionCard>

              {/* Brand Story — folded into page-builder 2026-05-20 (was a
                  theme toggle in Branding before). Content sourced from
                  store.heroImage + store.description{Ar}. */}
              <ExtraSectionCard
                kind="brandStory"
                label={t('sections.brandStory')}
                description={t('sections.brandStoryDescription')}
                settings={layout.brandStory}
                legacyEnabled={storeInfo?.theme?.showBrandStory !== false}
                onPatch={patch =>
                  setLayout(prev =>
                    prev ? { ...prev, brandStory: { ...(prev.brandStory ?? {}), ...patch } } : prev
                  )
                }
                theme={storeInfo?.theme ?? FALLBACK_THEME}
              />

              {/* Home blog carousel */}
              <ExtraSectionCard
                kind="blogCarousel"
                label={t('sections.blogCarousel')}
                description={t('sections.blogCarouselDescription')}
                settings={layout.blogCarousel}
                legacyEnabled={storeInfo?.blogEnabled === true}
                onPatch={patch =>
                  setLayout(prev =>
                    prev
                      ? { ...prev, blogCarousel: { ...(prev.blogCarousel ?? {}), ...patch } }
                      : prev
                  )
                }
                theme={storeInfo?.theme ?? FALLBACK_THEME}
              />

              {/* Trust strip — 3 trust-signal badges (delivery / returns / support) */}
              <ExtraSectionCard
                kind="trustStrip"
                label={t('sections.trustStrip')}
                description={t('sections.trustStripDescription')}
                settings={layout.trustStrip}
                legacyEnabled={storeInfo?.theme?.showTrustStrip !== false}
                onPatch={patch =>
                  setLayout(prev =>
                    prev ? { ...prev, trustStrip: { ...(prev.trustStrip ?? {}), ...patch } } : prev
                  )
                }
                theme={storeInfo?.theme ?? FALLBACK_THEME}
              />

              {/* Announcement bar — text content edited via /announcement page;
                  this card controls visibility + chrome (bg/dividers/padding). */}
              <ExtraSectionCard
                kind="announcement"
                label={t('sections.announcementBar')}
                description={t('sections.announcementDescription')}
                settings={layout.announcement}
                legacyEnabled={true}
                onPatch={patch =>
                  setLayout(prev =>
                    prev
                      ? { ...prev, announcement: { ...(prev.announcement ?? {}), ...patch } }
                      : prev
                  )
                }
                theme={storeInfo?.theme ?? FALLBACK_THEME}
              />

              {/* Header — bg, dividers, sticky toggle + typography zones
                  (beforeHeader / header / storeName). Folded the platform-wide
                  typography zones in here 2026-05-20 so merchant has ONE
                  place for header chrome AND header text styling. */}
              <ExtraSectionCard
                kind="header"
                label={t('sections.header')}
                description={t('sections.headerDescription')}
                settings={layout.header}
                legacyEnabled={true}
                onPatch={patch =>
                  setLayout(prev =>
                    prev ? { ...prev, header: { ...(prev.header ?? {}), ...patch } } : prev
                  )
                }
                theme={storeInfo?.theme ?? FALLBACK_THEME}
                typographyZones={['beforeHeader', 'header', 'storeName']}
                globalZones={globalZones}
                onZonePatch={(zoneKey, next) =>
                  setGlobalZones(prev => ({
                    ...prev,
                    [zoneKey]: { ...(prev[zoneKey] ?? {}), ...next },
                  }))
                }
                onZoneReset={zoneKey =>
                  setGlobalZones(prev => {
                    const cp = { ...prev };
                    delete cp[zoneKey];
                    return cp;
                  })
                }
              />

              {/* Top utility bar — a thin links strip ABOVE the header (Elegant
                  + Classic packs). Lives here near the header where it visually
                  appears, not buried in the footer. Saved by the main Save
                  button via its own registered saver. */}
              <SectionCard
                title={t('header.topUtilityBarTitle')}
                description={t('header.topUtilityBarDescription')}
                defaultExpanded={false}
                alwaysOn
              >
                <FooterLinksEditor
                  storeId={storeId}
                  variant="embedded"
                  section="utility"
                  saveRef={utilityBarSaveRef}
                  stateRef={utilityStateRef}
                />
              </SectionCard>

              {/* Navigation — storefront header menu links. Collapsible like
                  every other section; saved by the main Save button via the
                  registered saver (no separate save button, no standalone page). */}
              <SectionCard
                title={t('header.storefrontNavTitle')}
                description={t('header.storefrontNavDescription')}
                defaultExpanded={false}
                alwaysOn
              >
                <NavMenuEditor
                  storeId={storeId}
                  variant="embedded"
                  saveRef={navSaveRef}
                  stateRef={navStateRef}
                />
              </SectionCard>

              {/* Footer — bg, dividers, padding + typography zones
                  (footer / afterFooter). Folded the platform-wide typography
                  zones in here 2026-05-20.

                  Footer link sections (Shop / Support / Company) are managed
                  on the standalone /pages route ("Footer Links" in Settings).
                  Cross-link from the section card so merchants discover both
                  surfaces without a 666-line component absorb (Ahmad audit
                  2026-05-21). */}
              {/* Footer card: chrome (background / dividers / spacing /
                  typography) PLUS the footer link columns + newsletter, folded
                  in as children. The top utility bar has its own card near the
                  header. Saved by the main Save button. */}
              <ExtraSectionCard
                kind="footer"
                label={t('sections.footer')}
                description={t('sections.footerDescription')}
                settings={layout.footer}
                legacyEnabled={true}
                onPatch={patch =>
                  setLayout(prev =>
                    prev ? { ...prev, footer: { ...(prev.footer ?? {}), ...patch } } : prev
                  )
                }
                theme={storeInfo?.theme ?? FALLBACK_THEME}
                typographyZones={['footer', 'afterFooter']}
                globalZones={globalZones}
                onZonePatch={(zoneKey, next) =>
                  setGlobalZones(prev => ({
                    ...prev,
                    [zoneKey]: { ...(prev[zoneKey] ?? {}), ...next },
                  }))
                }
                onZoneReset={zoneKey =>
                  setGlobalZones(prev => {
                    const cp = { ...prev };
                    delete cp[zoneKey];
                    return cp;
                  })
                }
              >
                <div className="border-t border-border pt-4">
                  <h4 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {t('footer.footerLinksTitle')}
                  </h4>
                  <FooterLinksEditor
                    storeId={storeId}
                    variant="embedded"
                    section="links"
                    saveRef={footerLinksSaveRef}
                    stateRef={footerLinksStateRef}
                  />
                </div>
              </ExtraSectionCard>

              {/* Bottom bar (mobile) — 3 optional color knobs: bar bg, active
                  icon/label, inactive icon/label. All default unset so existing
                  stores see zero visual change. Page-builder 2026-06-17.
                  EN: "Bottom bar (mobile)" / AR: "شريط التنقل السفلي (جوال)" */}
              <SectionCard
                title={t('footer.bottomBarTitle')}
                description={t('footer.bottomBarDescription')}
                defaultExpanded={false}
                // alwaysOn — this is a content-only card (color knobs, no
                // on/off toggle). Without it SectionCard gates `children` on
                // (alwaysOn || enabled); both are falsy here, so the card
                // expanded to an EMPTY body — the 3 ColorFields never rendered
                // and the control read as dead / "not pressable" (merchant
                // complaint 2026-06-18). Mirrors every other per-page design
                // card (Locations / Products / Cart / Checkout), all `alwaysOn`.
                alwaysOn
              >
                <div className="space-y-1">
                  <ColorField
                    label={t('footer.barBackgroundLabel')}
                    value={layout.bottomBar?.bgColor}
                    onChange={v =>
                      setLayout(prev =>
                        prev
                          ? { ...prev, bottomBar: { ...(prev.bottomBar ?? {}), bgColor: v } }
                          : prev
                      )
                    }
                    hint={t('footer.barBackgroundHint')}
                    theme={storeInfo?.theme ?? FALLBACK_THEME}
                    inheritFromToken="card"
                  />
                  <ColorField
                    label={t('footer.activeIconLabelColorLabel')}
                    value={layout.bottomBar?.activeColor}
                    onChange={v =>
                      setLayout(prev =>
                        prev
                          ? { ...prev, bottomBar: { ...(prev.bottomBar ?? {}), activeColor: v } }
                          : prev
                      )
                    }
                    hint={t('footer.activeIconLabelColorHint')}
                    theme={storeInfo?.theme ?? FALLBACK_THEME}
                    inheritFromToken="primary"
                  />
                  <ColorField
                    label={t('footer.inactiveIconLabelColorLabel')}
                    value={layout.bottomBar?.inactiveColor}
                    onChange={v =>
                      setLayout(prev =>
                        prev
                          ? { ...prev, bottomBar: { ...(prev.bottomBar ?? {}), inactiveColor: v } }
                          : prev
                      )
                    }
                    hint={t('footer.inactiveIconLabelColorHint')}
                    theme={storeInfo?.theme ?? FALLBACK_THEME}
                    inheritFromToken="muted"
                  />
                </div>
              </SectionCard>

              {/* Extra duplicated product carousels (section duplication 2026-05-20).
                  Renders one card per entry + a "+ add carousel" button at the
                  bottom. Up to 8 extras. */}
              {(layout.extraCarousels ?? []).map((extra, idx) => (
                <ExtraCarouselCard
                  key={extra.id}
                  storeId={storeId}
                  extra={extra}
                  index={idx}
                  total={(layout.extraCarousels ?? []).length}
                  onPatch={patch =>
                    setLayout(prev => {
                      if (!prev) return prev;
                      const list = [...(prev.extraCarousels ?? [])];
                      list[idx] = { ...list[idx], ...patch };
                      return { ...prev, extraCarousels: list };
                    })
                  }
                  onDelete={() =>
                    setLayout(prev => {
                      if (!prev) return prev;
                      const list = (prev.extraCarousels ?? []).filter((_, i) => i !== idx);
                      return { ...prev, extraCarousels: list };
                    })
                  }
                  onMove={delta =>
                    setLayout(prev => {
                      if (!prev) return prev;
                      const list = [...(prev.extraCarousels ?? [])];
                      const target = idx + delta;
                      if (target < 0 || target >= list.length) return prev;
                      [list[idx], list[target]] = [list[target], list[idx]];
                      return { ...prev, extraCarousels: list };
                    })
                  }
                  theme={storeInfo?.theme ?? FALLBACK_THEME}
                />
              ))}
              {(layout.extraCarousels?.length ?? 0) < 8 && (
                <button
                  type="button"
                  onClick={() =>
                    setLayout(prev => {
                      if (!prev) return prev;
                      const next: import('@ebda/shared').ExtraCarouselSettings = {
                        id:
                          typeof crypto !== 'undefined' && 'randomUUID' in crypto
                            ? crypto.randomUUID()
                            : `extra-${Date.now()}`,
                        productSource: 'newest',
                        enabled: true,
                        limit: 12,
                      };
                      return {
                        ...prev,
                        extraCarousels: [...(prev.extraCarousels ?? []), next],
                      };
                    })
                  }
                  className="w-full rounded-2xl border-2 border-dashed border-border bg-card/40 p-4 text-sm font-semibold text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                >
                  + Add product carousel ({layout.extraCarousels?.length ?? 0} / 8 used)
                </button>
              )}

              {/* Product Card Defaults — global card controls that apply
                  to the PLP, search, and any product surface outside the
                  homepage carousels. Per-section settings above override
                  these for homepage new-arrivals + best-sellers. */}
              <SectionCard
                title={t('productCard.everywhereTitle')}
                description={t('productCard.everywhereDescription')}
                alwaysOn
                defaultExpanded={false}
              >
                <ProductCardControls
                  values={layout.productCardDefaults ?? {}}
                  onChange={patch =>
                    setLayout(prev =>
                      prev
                        ? {
                            ...prev,
                            productCardDefaults: {
                              ...(prev.productCardDefaults ?? {}),
                              ...(patch as Partial<ProductCardDefaults>),
                            },
                          }
                        : prev
                    )
                  }
                  theme={storeInfo?.theme}
                />
                {/* Catalog-wide product card typography — applies to PLP, category, search.
                    Only productName / productPrice / productCta are relevant here. */}
                <SectionTypographyBlock
                  roles={['productName', 'productPrice', 'productCta']}
                  typography={layout.productCardDefaults?.typography}
                  globalZones={Object.fromEntries(
                    (['productName', 'productPrice', 'productCta'] as const).map(r => [
                      r,
                      globalZones[ROLE_TO_GLOBAL_ZONE[r]],
                    ])
                  )}
                  onChangeRole={(role, next) =>
                    setLayout(prev =>
                      prev
                        ? {
                            ...prev,
                            productCardDefaults: {
                              ...(prev.productCardDefaults ?? {}),
                              typography: {
                                ...(prev.productCardDefaults?.typography ?? {}),
                                [role]: {
                                  ...(prev.productCardDefaults?.typography?.[
                                    role as keyof SectionTypographyOverride
                                  ] ?? {}),
                                  ...next,
                                },
                              },
                            },
                          }
                        : prev
                    )
                  }
                  onResetRole={role =>
                    setLayout(prev => {
                      if (!prev) return prev;
                      const rest = {
                        ...(prev.productCardDefaults?.typography ?? {}),
                      } as SectionTypographyOverride;
                      delete rest[role as keyof SectionTypographyOverride];
                      return {
                        ...prev,
                        productCardDefaults: {
                          ...(prev.productCardDefaults ?? {}),
                          typography: Object.keys(rest).length ? rest : undefined,
                        },
                      };
                    })
                  }
                  theme={storeInfo?.theme}
                />
                {/* Card-level toggles (Ahmad 2026-05-20: moved from
                    branding/ThemeTab → here. These flags affect every
                    product card on the store — PLP, categories, search,
                    homepage carousels — so they belong on the catalog-wide
                    Product Card Defaults card alongside frame/size/typography). */}
                <div className="mt-4 space-y-3 border-t border-border/40 pt-4">
                  <label className="flex items-center justify-between gap-4 rounded-lg border border-border bg-card p-4 cursor-pointer">
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm font-semibold text-foreground">
                        {t('productCard.brandBadgeTitle')}
                      </span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {t('productCard.brandBadgeHint')}
                      </span>
                    </span>
                    <input
                      type="checkbox"
                      checked={
                        pendingThemeUpdates.showBrandBadge ??
                        storeInfo?.theme?.showBrandBadge === true
                      }
                      onChange={e =>
                        setPendingThemeUpdates(prev => ({
                          ...prev,
                          showBrandBadge: e.target.checked,
                        }))
                      }
                      className="h-5 w-5 cursor-pointer accent-primary"
                    />
                  </label>
                  <label className="flex items-center justify-between gap-4 rounded-lg border border-border bg-card p-4 cursor-pointer">
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm font-semibold text-foreground">
                        {t('productCard.newBadgeTitle')}
                      </span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {t('productCard.newBadgeHint')}
                      </span>
                    </span>
                    {/* Ruling D1016-NEW-1: the "New" badge is the merchant's choice, default OFF. */}
                    <input
                      type="checkbox"
                      checked={
                        pendingThemeUpdates.showNewBadge ?? storeInfo?.theme?.showNewBadge === true
                      }
                      onChange={e =>
                        setPendingThemeUpdates(prev => ({
                          ...prev,
                          showNewBadge: e.target.checked,
                        }))
                      }
                      className="h-5 w-5 cursor-pointer accent-primary"
                    />
                  </label>
                  <label className="flex items-center justify-between gap-4 rounded-lg border border-border bg-card p-4 cursor-pointer">
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm font-semibold text-foreground">
                        {t('productCard.quickAddTitle')}
                      </span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {t('productCard.quickAddHint')}
                      </span>
                    </span>
                    <input
                      type="checkbox"
                      checked={
                        pendingThemeUpdates.showQuickAdd ?? storeInfo?.theme?.showQuickAdd === true
                      }
                      onChange={e =>
                        setPendingThemeUpdates(prev => ({
                          ...prev,
                          showQuickAdd: e.target.checked,
                        }))
                      }
                      className="h-5 w-5 cursor-pointer accent-primary"
                    />
                  </label>
                  {/* Price visibility is the single "Show product price" toggle in the
                      Card image shape group below (productCardDefaults.showCardPrice).
                      The legacy store-wide theme.showPriceOnCards toggle was redundant
                      and has been removed. */}
                  {/* Item 10 — image normalization */}
                  <label className="flex items-center justify-between gap-4 rounded-lg border border-border bg-card p-4 cursor-pointer">
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm font-semibold text-foreground">
                        {t('productCard.normalizeImagesTitle')}
                      </span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {t('productCard.normalizeImagesHint')}
                      </span>
                    </span>
                    <input
                      type="checkbox"
                      checked={
                        pendingThemeUpdates.normalizeProductImages ??
                        storeInfo?.theme?.normalizeProductImages === true
                      }
                      onChange={e =>
                        setPendingThemeUpdates(prev => ({
                          ...prev,
                          normalizeProductImages: e.target.checked,
                        }))
                      }
                      className="h-5 w-5 cursor-pointer accent-primary"
                    />
                  </label>
                  {/* Items 8 + 9 — image aspect, radius, label visibility */}
                  <div className="rounded-lg border border-border bg-card p-4 space-y-4">
                    <p className="text-sm font-semibold text-foreground">
                      {t('productCard.cardImageShapeTitle')}
                    </p>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs text-muted-foreground mb-1">
                          {t('productCard.imageAspectRatioLabel')}
                        </label>
                        <select
                          value={layout.productCardDefaults?.cardImageAspect ?? ''}
                          onChange={e =>
                            setLayout(prev =>
                              prev
                                ? {
                                    ...prev,
                                    productCardDefaults: {
                                      ...(prev.productCardDefaults ?? {}),
                                      cardImageAspect:
                                        (e.target
                                          .value as import('@ebda/shared').CardImageAspect) ||
                                        undefined,
                                    },
                                  }
                                : prev
                            )
                          }
                          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                        >
                          <option value="">{t('common.themeDefault')}</option>
                          <option value="1:1">{t('productCard.imageShapeSquare')}</option>
                          <option value="4:5">{t('productCard.imageShapePortrait45')}</option>
                          <option value="3:4">{t('productCard.imageShapeTallPortrait')}</option>
                          <option value="16:9">{t('productCard.imageShapeLandscape169')}</option>
                          <option value="auto">
                            {t('productCard.imageShapeAutoNoConstraint')}
                          </option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs text-muted-foreground mb-1">
                          {t('productCard.cornerRadiusLabel')}
                        </label>
                        <select
                          value={layout.productCardDefaults?.cardImageRadius ?? ''}
                          onChange={e =>
                            setLayout(prev =>
                              prev
                                ? {
                                    ...prev,
                                    productCardDefaults: {
                                      ...(prev.productCardDefaults ?? {}),
                                      cardImageRadius:
                                        (e.target
                                          .value as import('@ebda/shared').CardImageRadius) ||
                                        undefined,
                                    },
                                  }
                                : prev
                            )
                          }
                          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                        >
                          <option value="">{t('common.themeDefault')}</option>
                          <option value="none">{t('productCard.radiusNone')}</option>
                          <option value="sm">{t('common.small')}</option>
                          <option value="md">{t('common.medium')}</option>
                          <option value="lg">{t('common.large')}</option>
                          <option value="full">{t('productCard.radiusFull')}</option>
                        </select>
                      </div>
                    </div>
                    <div className="space-y-2 pt-1">
                      <label className="flex items-center justify-between gap-4 cursor-pointer">
                        <span className="text-sm text-foreground">{t('productCard.showName')}</span>
                        <input
                          type="checkbox"
                          checked={layout.productCardDefaults?.showCardName !== false}
                          onChange={e =>
                            setLayout(prev =>
                              prev
                                ? {
                                    ...prev,
                                    productCardDefaults: {
                                      ...(prev.productCardDefaults ?? {}),
                                      showCardName: e.target.checked,
                                    },
                                  }
                                : prev
                            )
                          }
                          className="h-4 w-4 cursor-pointer accent-primary"
                        />
                      </label>
                      <label className="flex items-center justify-between gap-4 cursor-pointer">
                        <span className="text-sm text-foreground">
                          {t('productCard.showPrice')}
                        </span>
                        <input
                          type="checkbox"
                          checked={layout.productCardDefaults?.showCardPrice !== false}
                          onChange={e =>
                            setLayout(prev =>
                              prev
                                ? {
                                    ...prev,
                                    productCardDefaults: {
                                      ...(prev.productCardDefaults ?? {}),
                                      showCardPrice: e.target.checked,
                                    },
                                  }
                                : prev
                            )
                          }
                          className="h-4 w-4 cursor-pointer accent-primary"
                        />
                      </label>
                      <div>
                        <label className="block text-xs text-muted-foreground mb-1">
                          {t('productCard.productNameCaseLabel')}
                        </label>
                        <select
                          value={layout.productCardDefaults?.productNameCase ?? ''}
                          onChange={e =>
                            setLayout(prev =>
                              prev
                                ? {
                                    ...prev,
                                    productCardDefaults: {
                                      ...(prev.productCardDefaults ?? {}),
                                      productNameCase:
                                        (e.target.value as 'normal' | 'uppercase') || undefined,
                                    },
                                  }
                                : prev
                            )
                          }
                          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                        >
                          <option value="">{t('common.themeDefault')}</option>
                          <option value="normal">{t('common.normal')}</option>
                          <option value="uppercase">{t('productCard.textUppercase')}</option>
                        </select>
                      </div>
                    </div>
                  </div>
                  {/* Call-to-action button group */}
                  <div className="rounded-lg border border-border bg-card p-4 space-y-4">
                    <p className="text-sm font-semibold text-foreground">
                      {t('productCard.ctaTitle')}
                    </p>
                    {/* Card button mode — controls whether no-variant in-stock products
                        show an inline Add-to-cart button (auto) or a View link (viewOnly). */}
                    <div>
                      <label className="block text-xs text-muted-foreground mb-1">
                        {t('productCard.ctaModeLabel')}
                      </label>
                      <select
                        value={layout.productCardDefaults?.ctaMode ?? ''}
                        onChange={e =>
                          setLayout(prev =>
                            prev
                              ? {
                                  ...prev,
                                  productCardDefaults: {
                                    ...(prev.productCardDefaults ?? {}),
                                    ctaMode: (e.target.value as 'auto' | 'viewOnly') || undefined,
                                  },
                                }
                              : prev
                          )
                        }
                        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                      >
                        <option value="">{t('productCard.ctaModeAuto')}</option>
                        <option value="viewOnly">{t('productCard.ctaModeViewOnly')}</option>
                      </select>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs text-muted-foreground mb-1">
                          {t('productCard.ctaShapeLabel')}
                        </label>
                        <select
                          value={layout.productCardDefaults?.ctaShape ?? ''}
                          onChange={e =>
                            setLayout(prev =>
                              prev
                                ? {
                                    ...prev,
                                    productCardDefaults: {
                                      ...(prev.productCardDefaults ?? {}),
                                      ctaShape:
                                        (e.target.value as
                                          | 'rounded'
                                          | 'pill'
                                          | 'square'
                                          | 'soft') || undefined,
                                    },
                                  }
                                : prev
                            )
                          }
                          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                        >
                          <option value="">{t('common.themeDefault')}</option>
                          <option value="rounded">{t('common.rounded')}</option>
                          <option value="pill">{t('common.pill')}</option>
                          <option value="square">{t('common.square')}</option>
                          <option value="soft">{t('common.soft')}</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs text-muted-foreground mb-1">
                          {t('productCard.ctaSizeLabel')}
                        </label>
                        <select
                          value={layout.productCardDefaults?.ctaSize ?? ''}
                          onChange={e =>
                            setLayout(prev =>
                              prev
                                ? {
                                    ...prev,
                                    productCardDefaults: {
                                      ...(prev.productCardDefaults ?? {}),
                                      ctaSize: (e.target.value as 'sm' | 'md' | 'lg') || undefined,
                                    },
                                  }
                                : prev
                            )
                          }
                          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                        >
                          <option value="">{t('common.auto')}</option>
                          <option value="sm">{t('common.small')}</option>
                          <option value="md">{t('common.medium')}</option>
                          <option value="lg">{t('common.large')}</option>
                        </select>
                      </div>
                    </div>
                    <div className="space-y-2 pt-1">
                      <label className="flex items-center justify-between gap-4 cursor-pointer">
                        <span className="text-sm text-foreground">
                          {t('productCard.customCtaLabel')}
                        </span>
                        <input
                          type="checkbox"
                          checked={layout.productCardDefaults?.ctaLabel === true}
                          onChange={e =>
                            setLayout(prev =>
                              prev
                                ? {
                                    ...prev,
                                    productCardDefaults: {
                                      ...(prev.productCardDefaults ?? {}),
                                      ctaLabel: e.target.checked,
                                    },
                                  }
                                : prev
                            )
                          }
                          className="h-4 w-4 cursor-pointer accent-primary"
                        />
                      </label>
                      {layout.productCardDefaults?.ctaLabel && (
                        <div className="grid grid-cols-2 gap-3 ms-4 border-s-2 border-s-primary/30 ps-3">
                          <div>
                            <label className="block text-xs text-muted-foreground mb-1">
                              {t('productCard.ctaLabelEn')}
                            </label>
                            <input
                              type="text"
                              value={layout.productCardDefaults?.ctaLabelTextEn ?? ''}
                              onChange={e =>
                                setLayout(prev =>
                                  prev
                                    ? {
                                        ...prev,
                                        productCardDefaults: {
                                          ...(prev.productCardDefaults ?? {}),
                                          ctaLabelTextEn: e.target.value || undefined,
                                        },
                                      }
                                    : prev
                                )
                              }
                              placeholder="Add to cart"
                              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                            />
                          </div>
                          <div>
                            <label className="block text-xs text-muted-foreground mb-1">
                              {t('productCard.ctaLabelAr')}
                            </label>
                            <input
                              type="text"
                              dir="rtl"
                              value={layout.productCardDefaults?.ctaLabelTextAr ?? ''}
                              onChange={e =>
                                setLayout(prev =>
                                  prev
                                    ? {
                                        ...prev,
                                        productCardDefaults: {
                                          ...(prev.productCardDefaults ?? {}),
                                          ctaLabelTextAr: e.target.value || undefined,
                                        },
                                      }
                                    : prev
                                )
                              }
                              placeholder="أضف للسلة"
                              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                            />
                          </div>
                        </div>
                      )}
                    </div>
                    <ColorField
                      label={t('productCard.ctaBgColorLabel')}
                      value={layout.productCardDefaults?.ctaColor}
                      onChange={v =>
                        setLayout(prev =>
                          prev
                            ? {
                                ...prev,
                                productCardDefaults: {
                                  ...(prev.productCardDefaults ?? {}),
                                  ctaColor: v || undefined,
                                },
                              }
                            : prev
                        )
                      }
                      theme={storeInfo?.theme ?? FALLBACK_THEME}
                      inheritFromToken="primary"
                    />
                    <ColorField
                      label={t('productCard.ctaTextColorLabel')}
                      value={layout.productCardDefaults?.ctaTextColor}
                      onChange={v =>
                        setLayout(prev =>
                          prev
                            ? {
                                ...prev,
                                productCardDefaults: {
                                  ...(prev.productCardDefaults ?? {}),
                                  ctaTextColor: v || undefined,
                                },
                              }
                            : prev
                        )
                      }
                      theme={storeInfo?.theme ?? FALLBACK_THEME}
                      inheritFromToken="foreground"
                    />
                  </div>
                  {/* Out-of-stock label group */}
                  <div className="rounded-lg border border-border bg-card p-4 space-y-4">
                    <p className="text-sm font-semibold text-foreground">
                      {t('productCard.oosTitle')}
                    </p>
                    <div className="space-y-2">
                      <label className="flex items-center justify-between gap-4 cursor-pointer">
                        <span className="text-sm text-foreground">
                          {t('productCard.showOosLabel')}
                        </span>
                        <input
                          type="checkbox"
                          checked={layout.productCardDefaults?.oosLabel === true}
                          onChange={e =>
                            setLayout(prev =>
                              prev
                                ? {
                                    ...prev,
                                    productCardDefaults: {
                                      ...(prev.productCardDefaults ?? {}),
                                      oosLabel: e.target.checked,
                                    },
                                  }
                                : prev
                            )
                          }
                          className="h-4 w-4 cursor-pointer accent-primary"
                        />
                      </label>
                      {layout.productCardDefaults?.oosLabel && (
                        <div className="space-y-3 ms-4 border-s-2 border-s-primary/30 ps-3">
                          <div className="grid grid-cols-2 gap-3">
                            <div>
                              <label className="block text-xs text-muted-foreground mb-1">
                                {t('productCard.oosLabelEn')}
                              </label>
                              <input
                                type="text"
                                value={layout.productCardDefaults?.oosLabelTextEn ?? ''}
                                onChange={e =>
                                  setLayout(prev =>
                                    prev
                                      ? {
                                          ...prev,
                                          productCardDefaults: {
                                            ...(prev.productCardDefaults ?? {}),
                                            oosLabelTextEn: e.target.value || undefined,
                                          },
                                        }
                                      : prev
                                  )
                                }
                                placeholder="Out of stock"
                                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                              />
                            </div>
                            <div>
                              <label className="block text-xs text-muted-foreground mb-1">
                                {t('productCard.oosLabelAr')}
                              </label>
                              <input
                                type="text"
                                dir="rtl"
                                value={layout.productCardDefaults?.oosLabelTextAr ?? ''}
                                onChange={e =>
                                  setLayout(prev =>
                                    prev
                                      ? {
                                          ...prev,
                                          productCardDefaults: {
                                            ...(prev.productCardDefaults ?? {}),
                                            oosLabelTextAr: e.target.value || undefined,
                                          },
                                        }
                                      : prev
                                  )
                                }
                                placeholder="نفد المخزون"
                                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                              />
                            </div>
                          </div>
                          <div className="grid grid-cols-2 gap-3">
                            <div>
                              <label className="block text-xs text-muted-foreground mb-1">
                                {t('productCard.labelShapeLabel')}
                              </label>
                              <select
                                value={layout.productCardDefaults?.oosLabelShape ?? ''}
                                onChange={e =>
                                  setLayout(prev =>
                                    prev
                                      ? {
                                          ...prev,
                                          productCardDefaults: {
                                            ...(prev.productCardDefaults ?? {}),
                                            oosLabelShape:
                                              (e.target.value as
                                                | 'rounded'
                                                | 'pill'
                                                | 'square'
                                                | 'soft') || undefined,
                                          },
                                        }
                                      : prev
                                  )
                                }
                                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                              >
                                <option value="">{t('common.themeDefault')}</option>
                                <option value="rounded">{t('common.rounded')}</option>
                                <option value="pill">{t('common.pill')}</option>
                                <option value="square">{t('common.square')}</option>
                                <option value="soft">{t('common.soft')}</option>
                              </select>
                            </div>
                            <div>
                              <label className="block text-xs text-muted-foreground mb-1">
                                {t('productCard.labelPlacementLabel')}
                              </label>
                              <select
                                value={layout.productCardDefaults?.oosLabelPlacement ?? ''}
                                onChange={e =>
                                  setLayout(prev =>
                                    prev
                                      ? {
                                          ...prev,
                                          productCardDefaults: {
                                            ...(prev.productCardDefaults ?? {}),
                                            oosLabelPlacement:
                                              (e.target.value as
                                                | 'top-start'
                                                | 'top-end'
                                                | 'bottom-start'
                                                | 'bottom-end') || undefined,
                                          },
                                        }
                                      : prev
                                  )
                                }
                                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                              >
                                <option value="">{t('common.themeDefault')}</option>
                                <option value="top-start">
                                  {t('productCard.placementTopStart')}
                                </option>
                                <option value="top-end">{t('productCard.placementTopEnd')}</option>
                                <option value="bottom-start">
                                  {t('productCard.placementBottomStart')}
                                </option>
                                <option value="bottom-end">
                                  {t('productCard.placementBottomEnd')}
                                </option>
                              </select>
                            </div>
                          </div>
                          <ColorField
                            label={t('productCard.oosBgColorLabel')}
                            value={layout.productCardDefaults?.oosLabelColor}
                            onChange={v =>
                              setLayout(prev =>
                                prev
                                  ? {
                                      ...prev,
                                      productCardDefaults: {
                                        ...(prev.productCardDefaults ?? {}),
                                        oosLabelColor: v || undefined,
                                      },
                                    }
                                  : prev
                              )
                            }
                            theme={storeInfo?.theme ?? FALLBACK_THEME}
                            inheritFromToken="muted"
                          />
                          <ColorField
                            label={t('productCard.oosTextColorLabel')}
                            value={layout.productCardDefaults?.oosLabelTextColor}
                            onChange={v =>
                              setLayout(prev =>
                                prev
                                  ? {
                                      ...prev,
                                      productCardDefaults: {
                                        ...(prev.productCardDefaults ?? {}),
                                        oosLabelTextColor: v || undefined,
                                      },
                                    }
                                  : prev
                              )
                            }
                            theme={storeInfo?.theme ?? FALLBACK_THEME}
                            inheritFromToken="foreground"
                          />
                          <ColorField
                            label={t('productCard.dimColorLabel')}
                            value={layout.productCardDefaults?.oosDimColor}
                            onChange={v =>
                              setLayout(prev =>
                                prev
                                  ? {
                                      ...prev,
                                      productCardDefaults: {
                                        ...(prev.productCardDefaults ?? {}),
                                        oosDimColor: v || undefined,
                                      },
                                    }
                                  : prev
                              )
                            }
                            hint={t('productCard.dimColorHint')}
                            theme={storeInfo?.theme ?? FALLBACK_THEME}
                          />
                        </div>
                      )}
                    </div>
                  </div>
                  {/* Discount / sale badge group — merchant-configurable
                      corner + color for the "Save X" / "-X%" chip. Default
                      (unset) = bottom-left corner, theme destructive/red
                      color. Position is PHYSICAL (not RTL-mirrored) — "Bottom
                      left" always renders bottom-left, in Arabic stores too. */}
                  <div className="rounded-lg border border-border bg-card p-4 space-y-4">
                    <p className="text-sm font-semibold text-foreground">
                      {t('productCard.discountBadgeTitle')}
                    </p>
                    {/* #1998 — per-store StoreTheme flag (shallow-merge theme PATCH on
                        Save, via pendingThemeUpdates). Off = the unset badge sits in
                        the image's top corner; on = the legacy bottom-left corner. */}
                    <label className="flex items-center justify-between gap-4 rounded-lg border border-border bg-background p-3 cursor-pointer">
                      <span className="flex-1 min-w-0">
                        <span className="block text-sm font-medium text-foreground">
                          {t('productCard.saleBadgeLegacyCornerTitle')}
                        </span>
                        <span className="mt-0.5 block text-xs text-muted-foreground">
                          {t('productCard.saleBadgeLegacyCornerHint')}
                        </span>
                      </span>
                      <input
                        type="checkbox"
                        checked={saleBadgeLegacyCorner}
                        onChange={e =>
                          setPendingThemeUpdates(prev => ({
                            ...prev,
                            saleBadgeLegacyCorner: e.target.checked,
                          }))
                        }
                        className="h-5 w-5 cursor-pointer accent-primary"
                      />
                    </label>
                    <div>
                      <label className="block text-xs text-muted-foreground mb-1">
                        {t('productCard.badgePositionLabel')}
                      </label>
                      <select
                        value={layout.productCardDefaults?.discountBadge?.position ?? ''}
                        onChange={e =>
                          setLayout(prev =>
                            prev
                              ? {
                                  ...prev,
                                  productCardDefaults: {
                                    ...(prev.productCardDefaults ?? {}),
                                    discountBadge: {
                                      ...(prev.productCardDefaults?.discountBadge ?? {}),
                                      position:
                                        (e.target.value as
                                          | 'top-left'
                                          | 'top-right'
                                          | 'bottom-left'
                                          | 'bottom-right') || undefined,
                                    },
                                  },
                                }
                              : prev
                          )
                        }
                        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                      >
                        <option value="">
                          {saleBadgeLegacyCorner
                            ? t('productCard.positionBottomLeftDefault')
                            : t('productCard.positionTopStartDefault')}
                        </option>
                        <option value="top-left">{t('productCard.positionTopLeft')}</option>
                        <option value="top-right">{t('productCard.positionTopRight')}</option>
                        <option value="bottom-left">{t('productCard.positionBottomLeft')}</option>
                        <option value="bottom-right">{t('productCard.positionBottomRight')}</option>
                      </select>
                    </div>
                    <ColorField
                      label={t('productCard.badgeColorLabel')}
                      value={layout.productCardDefaults?.discountBadge?.color}
                      onChange={v =>
                        setLayout(prev =>
                          prev
                            ? {
                                ...prev,
                                productCardDefaults: {
                                  ...(prev.productCardDefaults ?? {}),
                                  discountBadge: {
                                    ...(prev.productCardDefaults?.discountBadge ?? {}),
                                    color: v || undefined,
                                  },
                                },
                              }
                            : prev
                        )
                      }
                      hint={t('productCard.discountBadgeColorHint')}
                      theme={storeInfo?.theme ?? FALLBACK_THEME}
                    />
                  </div>
                  {/* Custom product badge group — corner + color for the
                      merchant's own per-product label (Product.badgeLabel /
                      badgeLabelAr, set on the product edit form). This block
                      only STYLES the badge; whether it appears at all is
                      per-product data, so there is deliberately no enable
                      toggle here — an empty label already means off.
                      Default (unset) = bottom-right corner, primary color:
                      a different corner from the discount badge's bottom-left
                      default so both show out of the box. When they DO share
                      a corner, the custom badge wins and the discount badge is
                      suppressed — see custom-badge.ts. Position is PHYSICAL
                      (not RTL-mirrored), same as the discount badge. */}
                  <div className="rounded-lg border border-border bg-card p-4 space-y-4">
                    <p className="text-sm font-semibold text-foreground">
                      {t('productCard.customBadgeTitle')}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t('productCard.customBadgeStylingHint')}
                    </p>
                    <div>
                      <label className="block text-xs text-muted-foreground mb-1">
                        {t('productCard.badgePositionLabel')}
                      </label>
                      <select
                        value={layout.productCardDefaults?.customBadge?.position ?? ''}
                        onChange={e =>
                          setLayout(prev =>
                            prev
                              ? {
                                  ...prev,
                                  productCardDefaults: {
                                    ...(prev.productCardDefaults ?? {}),
                                    customBadge: {
                                      ...(prev.productCardDefaults?.customBadge ?? {}),
                                      position:
                                        (e.target.value as
                                          | 'top-left'
                                          | 'top-right'
                                          | 'bottom-left'
                                          | 'bottom-right') || undefined,
                                    },
                                  },
                                }
                              : prev
                          )
                        }
                        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                      >
                        <option value="">{t('productCard.positionBottomRightDefault')}</option>
                        <option value="top-left">{t('productCard.positionTopLeft')}</option>
                        <option value="top-right">{t('productCard.positionTopRight')}</option>
                        <option value="bottom-left">{t('productCard.positionBottomLeft')}</option>
                        <option value="bottom-right">{t('productCard.positionBottomRight')}</option>
                      </select>
                    </div>
                    <ColorField
                      label={t('productCard.badgeColorLabel')}
                      value={layout.productCardDefaults?.customBadge?.color}
                      onChange={v =>
                        setLayout(prev =>
                          prev
                            ? {
                                ...prev,
                                productCardDefaults: {
                                  ...(prev.productCardDefaults ?? {}),
                                  customBadge: {
                                    ...(prev.productCardDefaults?.customBadge ?? {}),
                                    color: v || undefined,
                                  },
                                },
                              }
                            : prev
                        )
                      }
                      hint={t('productCard.customBadgeColorHint')}
                      theme={storeInfo?.theme ?? FALLBACK_THEME}
                    />
                  </div>
                </div>
                <div className="mt-4">
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {t('preview.liveTitle')}
                  </p>
                  <SectionPreview
                    label={t('productCard.sectionTitle')}
                    bgColor={undefined}
                    cardFrameColor={layout.productCardDefaults?.cardFrameColor}
                    cardFrameWidth={layout.productCardDefaults?.cardFrameWidth}
                    cardFrameSize={layout.productCardDefaults?.cardFrameSize}
                    headingZone={layout.productCardDefaults?.typography?.productName}
                    theme={storeInfo?.theme ?? FALLBACK_THEME}
                  />
                </div>
              </SectionCard>

              {/* Sizing contract section removed 2026-05-16 — its 3 fields
                  (heroAspect / productImageAspect / categoryImageAspect)
                  were never consumed by the storefront. The per-section
                  cardAspect / cardShape controls on Categories +
                  NewArrivals + BestSellers are the actual source of truth
                  for image aspect ratios. The underlying type field
                  (`layout.sizing.*`) stays in DEFAULT_LAYOUT_SETTINGS for
                  back-compat with existing stores' saved JSON but isn't
                  surfaced in admin or read by render code. */}

              {/* Platform-wide section dividers card deleted 2026-05-20. Per-section dividers now live inside each SectionCard above. Storefront falls back to legacy theme.dividers for existing stores. */}

              {/* Platform-wide Header + Footer typography card removed
                  2026-05-20. Zones (beforeHeader / header / storeName /
                  footer / afterFooter) moved into the Header and Footer
                  ExtraSectionCards above via the `typographyZones` prop —
                  merchant edits chrome AND text styling in one place. */}
            </>
          )}
        </div>

        {/* Live preview pane — iframe to the storefront. CSP frame-ancestors
            was relaxed to allow framing from store.ebda.app (admin) +
            localhost:3001 (dev). 2026-05-20: was a "click to open" link
            because of stricter CSP; now renders inline. */}
        <aside className="hidden lg:block">
          <div className="sticky top-4 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-foreground">{t('preview.liveTitle')}</h3>
              <div className="flex items-center gap-2">
                {previewUrl && (
                  <a
                    href={previewUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[11px] font-semibold text-primary hover:underline"
                  >
                    {t('preview.openInNewTab')}
                  </a>
                )}
              </div>
            </div>
            {previewUrl ? (
              <div className="flex justify-center overflow-hidden rounded-2xl border border-border bg-card">
                {(() => {
                  const sep = previewUrl.includes('?') ? '&' : '?';
                  const draft = previewDraftToken
                    ? `&_layoutDraft=${encodeURIComponent(previewDraftToken)}`
                    : '';
                  const src = `${previewUrl}${sep}_preview=${previewRefreshTick}${draft}`;
                  const iframeKey = `${previewUrl}#${previewRefreshTick}#${
                    previewDraftToken ?? ''
                  }#${previewDevice}`;
                  // Mobile-only preview — true phone width (390px, iPhone logical
                  // width), centered. The desktop canvas was removed per Ahmad.
                  return (
                    <iframe
                      key={iframeKey}
                      src={src}
                      title={t('preview.iframeTitle')}
                      className="block h-[calc(100vh-200px)] w-[390px] max-w-full bg-background"
                      loading="lazy"
                      sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
                    />
                  );
                })()}
              </div>
            ) : (
              <div className="rounded-2xl border border-border bg-card p-6 text-center text-xs text-muted-foreground">
                {t('preview.unavailable')}
              </div>
            )}
            <p className="text-[11px] text-muted-foreground">
              {t.rich('preview.saveHint', { b: chunks => <strong>{chunks}</strong> })}
            </p>
          </div>
        </aside>
      </div>
      <SmartPaletteModal
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        theme={storeInfo?.theme}
        storeId={storeId}
        storeTemplate={storeInfo?.template}
        onApply={async (palette, themeUpdates: ThemeUpdates) => {
          // 1. Apply palette to layout state (same as before).
          setLayout(prev => {
            if (!prev) return prev;
            return {
              ...prev,
              hero: { ...prev.hero, bgColor: palette.hero.bgColor },
              categories: {
                ...prev.categories,
                bgColor: palette.categories.bgColor,
                showCardFrame: true,
                cardFrameColor: palette.categories.cardFrameColor,
                cardFrameWidth: palette.categories.cardFrameWidth,
                cardFrameSize: palette.categories.cardFrameSize,
              },
              newArrivals: {
                ...prev.newArrivals,
                bgColor: palette.newArrivals.bgColor,
                showCardFrame: true,
                cardFrameColor: palette.newArrivals.cardFrameColor,
                cardFrameWidth: palette.newArrivals.cardFrameWidth,
                cardFrameSize: palette.newArrivals.cardFrameSize,
              },
              bestSellers: {
                ...prev.bestSellers,
                bgColor: palette.bestSellers.bgColor,
                showCardFrame: true,
                cardFrameColor: palette.bestSellers.cardFrameColor,
                cardFrameWidth: palette.bestSellers.cardFrameWidth,
                cardFrameSize: palette.bestSellers.cardFrameSize,
              },
              testimonials: { ...prev.testimonials, bgColor: palette.testimonials.bgColor },
            };
          });

          // 2. Stage brand-token updates in local pending state instead of
          //    PUT-ing /theme immediately. The merchant clicks the main Save
          //    button to commit layout + typography + theme together. This
          //    matches every other admin form's "edit locally, save explicitly"
          //    behavior — Ahmad 2026-05-20: "smart palette does apply
          //    automatically i don't want this".
          const hasThemeUpdates = Object.keys(themeUpdates).some(
            k =>
              ![
                'showBrandBadge',
                'showNewBadge',
                'showQuickAdd',
                'showPriceOnCards',
                'normalizeProductImages',
              ].includes(k)
          );
          if (hasThemeUpdates) {
            setPendingThemeUpdates(prev => ({ ...prev, ...themeUpdates }));
          }
        }}
      />
    </AdminLayout>
  );
}

interface SectionCardProps {
  title: string;
  description: string;
  enabled?: boolean;
  alwaysOn?: boolean;
  onToggle?: (v: boolean) => void;
  /** When true the card renders expanded by default. Defaults to false. */
  defaultExpanded?: boolean;
  children?: React.ReactNode;
}

/**
 * Card-control row for sections that render image+text cards
 * (categories, newArrivals, bestSellers). Bundles size + aspect +
 * shape + spacing dropdowns and showLabel + showHover toggles.
 *
 * Values shape matches both `CategoriesSettings` and
 * `ProductCarouselSettings` — both have the same card-tuning fields,
 * so one component covers all 3 mount points.
 */
type CardControlsValues = {
  cardSize?: 'xxs' | 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  cardAspect?: 'theme' | 'square' | 'portrait' | 'landscape' | 'wide' | 'ultrawide';
  cardShape?:
    | 'theme'
    | 'circle'
    | 'rounded-square'
    | 'square'
    | 'soft'
    | 'portrait'
    | 'landscape'
    | 'pill';
  cardGap?: 'tight' | 'normal' | 'loose' | 'xloose';
  showLabel?: boolean;
  showHover?: boolean;
  showCardFrame?: boolean;
  cardFrameStyle?: 'soft' | 'outline' | 'shadow' | 'paper';
  /** Border width for the card frame — only visible when showCardFrame is on. */
  cardFrameWidth?: CardFrameWidth;
  /** Frame box padding — only visible when showCardFrame is on. */
  cardFrameSize?: CardFrameSize;
  /** Hex color for the card frame border — only visible when showCardFrame is on. */
  cardFrameColor?: string;
};

function ProductCardControls({
  values,
  onChange,
  theme,
}: {
  values: CardControlsValues;
  onChange: (patch: Partial<CardControlsValues>) => void;
  theme?: StoreTheme;
}) {
  const t = useT('orders.layout');
  return (
    <div className="mt-3 space-y-0">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t('productCard.cardSize')}</span>
          <select
            value={values.cardSize ?? 'sm'}
            onChange={e => onChange({ cardSize: e.target.value as CardControlsValues['cardSize'] })}
            className="rounded-lg border border-border bg-card px-3 py-2 text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          >
            <option value="xxs">{t('productCard.sizeTiniest')}</option>
            <option value="xs">{t('productCard.sizeXs')}</option>
            <option value="sm">{t('productCard.sizeSmDefault')}</option>
            <option value="md">{t('productCard.sizeMd')}</option>
            <option value="lg">{t('productCard.sizeLg')}</option>
            <option value="xl">{t('productCard.sizeXl')}</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t('productCard.imageAspect')}</span>
          <select
            value={values.cardAspect ?? 'theme'}
            onChange={e =>
              onChange({ cardAspect: e.target.value as CardControlsValues['cardAspect'] })
            }
            className="rounded-lg border border-border bg-card px-3 py-2 text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          >
            <option value="theme">{t('productCard.aspectThemeDefaultRatio')}</option>
            <option value="square">{t('productCard.aspectSquare')}</option>
            <option value="portrait">{t('productCard.aspectPortraitRatio')}</option>
            <option value="landscape">{t('productCard.aspectLandscapeRatio')}</option>
            <option value="wide">{t('productCard.aspectWideRatio')}</option>
            <option value="ultrawide">{t('productCard.aspectUltrawideRatio')}</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t('productCard.cardShape')}</span>
          <select
            value={values.cardShape ?? 'theme'}
            onChange={e =>
              onChange({ cardShape: e.target.value as CardControlsValues['cardShape'] })
            }
            className="rounded-lg border border-border bg-card px-3 py-2 text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          >
            <option value="theme">{t('common.themeDefault')}</option>
            <option value="circle">{t('productCard.shapeCircle')}</option>
            <option value="rounded-square">{t('productCard.shapeRoundedSquare')}</option>
            <option value="square">{t('productCard.shapeSharpSquare')}</option>
            <option value="soft">{t('productCard.shapeSoftRectangle')}</option>
            <option value="portrait">{t('productCard.shapePortraitPlain')}</option>
            <option value="landscape">{t('productCard.shapeLandscapePlain')}</option>
            <option value="pill">{t('productCard.shapePillRatio')}</option>
          </select>
          <span className="text-[11px] text-muted-foreground/80">
            {t('productCard.shapeOverrideHint')}
          </span>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t('productCard.cardSpacing')}</span>
          <select
            value={values.cardGap ?? 'normal'}
            onChange={e => onChange({ cardGap: e.target.value as CardControlsValues['cardGap'] })}
            className="rounded-lg border border-border bg-card px-3 py-2 text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          >
            <option value="tight">{t('productCard.spacingTight')}</option>
            <option value="normal">{t('productCard.spacingNormalDefault')}</option>
            <option value="loose">{t('productCard.spacingLoose')}</option>
            <option value="xloose">{t('productCard.spacingXloose')}</option>
          </select>
        </label>
        <RowToggle
          label={t('productCard.showLabels')}
          checked={values.showLabel !== false}
          onChange={v => onChange({ showLabel: v })}
        />
        <RowToggle
          label={t('productCard.hoverEffects')}
          checked={values.showHover !== false}
          onChange={v => onChange({ showHover: v })}
        />
        <RowToggle
          label={t('productCard.showFrame')}
          checked={!!values.showCardFrame}
          onChange={v => onChange({ showCardFrame: v })}
        />
        {values.showCardFrame && (
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{t('productCard.frameStyle')}</span>
            <select
              value={values.cardFrameStyle ?? 'soft'}
              onChange={e =>
                onChange({
                  cardFrameStyle: e.target.value as CardControlsValues['cardFrameStyle'],
                })
              }
              className="rounded-lg border border-border bg-card px-3 py-2 text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            >
              <option value="soft">{t('productCard.frameSoftDefault')}</option>
              <option value="outline">{t('productCard.frameOutline')}</option>
              <option value="shadow">{t('productCard.frameShadow')}</option>
              <option value="paper">{t('productCard.framePaper')}</option>
            </select>
          </label>
        )}
        {values.showCardFrame && (
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{t('productCard.borderThickness')}</span>
            <select
              value={values.cardFrameWidth ?? 'thin'}
              onChange={e => onChange({ cardFrameWidth: e.target.value as CardFrameWidth })}
              className="rounded-lg border border-border bg-card px-3 py-2 text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            >
              <option value="thin">{t('productCard.borderThinDefault')}</option>
              <option value="normal">{t('productCard.borderNormal')}</option>
              <option value="thick">{t('productCard.borderThick')}</option>
              <option value="xthick">{t('productCard.borderXthick')}</option>
            </select>
          </label>
        )}
        {values.showCardFrame && (
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{t('productCard.frameSize')}</span>
            <select
              value={values.cardFrameSize ?? 'normal'}
              onChange={e => onChange({ cardFrameSize: e.target.value as CardFrameSize })}
              className="rounded-lg border border-border bg-card px-3 py-2 text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            >
              <option value="compact">{t('productCard.frameSizeCompact')}</option>
              <option value="normal">{t('productCard.frameSizeNormalDefault')}</option>
              <option value="comfortable">{t('productCard.frameSizeComfortable')}</option>
              <option value="spacious">{t('productCard.frameSizeSpacious')}</option>
            </select>
          </label>
        )}
      </div>
      {/* Card frame color — full-width below the grid so the color picker
          + clear button have room. Only shown when the frame toggle is on. */}
      {values.showCardFrame && (
        <ColorField
          label={t('productCard.frameColorLabel')}
          value={values.cardFrameColor}
          onChange={v => onChange({ cardFrameColor: v })}
          hint={t('productCard.frameColorHint')}
          theme={theme}
          inheritFromToken="border"
        />
      )}
    </div>
  );
}

/**
 * Manual light/dark override for a page's smart auto-contrast. 'auto' decides
 * from the background lightness; light/dark force it (for mid-tone bgs the auto
 * detection misjudges). Paired with the page ColorField.
 */
function SchemeSelect({
  value,
  onChange,
}: {
  value: 'auto' | 'light' | 'dark';
  onChange: (v: 'auto' | 'light' | 'dark') => void;
}) {
  const t = useT('orders.layout');
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">
        {t('typography.textContrastLabel')}
      </span>
      <select
        value={value}
        onChange={e => onChange(e.target.value as 'auto' | 'light' | 'dark')}
        className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
      >
        <option value="auto">{t('typography.contrastAuto')}</option>
        <option value="light">{t('typography.contrastLight')}</option>
        <option value="dark">{t('typography.contrastDark')}</option>
      </select>
    </label>
  );
}

/** Per-page spacing density — scales the page's vertical padding. */
function DensitySelect({
  value,
  onChange,
}: {
  value: 'compact' | 'normal' | 'spacious';
  onChange: (v: 'compact' | 'normal' | 'spacious') => void;
}) {
  const t = useT('orders.layout');
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">
        {t('typography.spacingDensityLabel')}
      </span>
      <select
        value={value}
        onChange={e => onChange(e.target.value as 'compact' | 'normal' | 'spacious')}
        className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
      >
        <option value="compact">{t('common.compact')}</option>
        <option value="normal">{t('common.normal')}</option>
        <option value="spacious">{t('common.spacious')}</option>
      </select>
    </label>
  );
}

/** Per-page text-size scale — bumps all the page's typography controls together. */
function TextScaleSelect({
  value,
  onChange,
}: {
  value: 'sm' | 'normal' | 'lg' | 'xl';
  onChange: (v: 'sm' | 'normal' | 'lg' | 'xl') => void;
}) {
  const t = useT('orders.layout');
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">
        {t('typography.textSizeLabel')}
      </span>
      <select
        value={value}
        onChange={e => onChange(e.target.value as 'sm' | 'normal' | 'lg' | 'xl')}
        className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
      >
        <option value="sm">{t('common.small')}</option>
        <option value="normal">{t('common.normal')}</option>
        <option value="lg">{t('common.large')}</option>
        <option value="xl">{t('common.extraLarge')}</option>
      </select>
    </label>
  );
}

function SectionCard({
  title,
  description,
  enabled,
  alwaysOn,
  onToggle,
  defaultExpanded,
  children,
}: SectionCardProps) {
  return (
    <details
      open={defaultExpanded}
      className="rounded-2xl border border-border bg-card transition-colors"
    >
      <summary className="cursor-pointer list-none px-5 py-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold text-foreground">{title}</h2>
            <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
          </div>
          {/* The enabled toggle is inside summary so merchant can flip it
              without expanding. stopPropagation prevents the click from
              also toggling the details open/closed state. */}
          {!alwaysOn && onToggle && (
            <div
              onClick={e => e.stopPropagation()}
              onKeyDown={e => e.stopPropagation()}
              role="presentation"
            >
              <Toggle checked={!!enabled} onChange={onToggle} />
            </div>
          )}
        </div>
      </summary>
      {(alwaysOn || enabled) && children && (
        <div className="border-t border-border px-5 py-4 space-y-3">{children}</div>
      )}
    </details>
  );
}

// Human-readable labels for the global zone keys — mirrors the labeling
// convention from the /typography page so merchants see consistent names.
// Translated inline via t('zoneLabels.*') at the single call site below
// (kept here only as the historical key-set reference in the comment).

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

// parseAspect + SizingFieldWithPreview removed 2026-05-16 alongside the
// Sizing contract SectionCard (heroAspect / productImageAspect /
// categoryImageAspect fields never consumed by the storefront — the
// per-section cardAspect / cardShape controls are the real source of
// truth for image aspect ratios).

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

function KickerSubtitleControls({
  storeId,
  section,
  values,
  onPatch,
  theme,
}: {
  storeId: string;
  section: 'categories' | 'newArrivals' | 'bestSellers' | 'featured' | 'testimonials';
  values: KickerSubtitleValues;
  onPatch: (patch: Partial<KickerSubtitleValues>) => void;
  /** Pass-through to the embedded SectionDividersBlock so its custom-color
   *  ColorField can resolve brand tokens. Optional — falls back to a hex-only
   *  picker when omitted. */
  theme?: import('@ebda/shared').StoreTheme;
}) {
  const t = useT('orders.layout');
  return (
    <>
      <div className="mt-3 flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">{t('kickerSubtitle.optionalHint')}</p>
        <AiSectionFillButton
          storeId={storeId}
          section={section}
          existingTitle={values.title}
          existingTitleAr={values.titleAr}
          onFilled={r =>
            onPatch({
              kicker: values.kicker || r.kicker,
              kickerAr: values.kickerAr || r.kickerAr,
              subtitle: values.subtitle || r.subtitle,
              subtitleAr: values.subtitleAr || r.subtitleAr,
            })
          }
        />
      </div>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <TextField
          label={t('kickerSubtitle.kickerLabelEn')}
          placeholder="e.g. EXPLORE"
          value={values.kicker ?? ''}
          onChange={v => onPatch({ kicker: v })}
        />
        <TextField
          label={t('kickerSubtitle.kickerLabelAr')}
          placeholder="مثال: استكشف"
          value={values.kickerAr ?? ''}
          onChange={v => onPatch({ kickerAr: v })}
          dir="rtl"
        />
        <TextField
          label={t('kickerSubtitle.subtitleLabelEn')}
          placeholder="e.g. Browse our top picks"
          value={values.subtitle ?? ''}
          onChange={v => onPatch({ subtitle: v })}
        />
        <TextField
          label={t('kickerSubtitle.subtitleLabelAr')}
          placeholder="مثال: تصفح أفضل اختياراتنا"
          value={values.subtitleAr ?? ''}
          onChange={v => onPatch({ subtitleAr: v })}
          dir="rtl"
        />
      </div>
      <SectionDividersBlock values={values} onPatch={onPatch} theme={theme} />
    </>
  );
}

/**
 * Per-section dividers block — 5 toggles for the 5 SectionDividers slots
 * (above / kicker / title / subtitle / belowHeading). Each toggle writes
 * to `dividers.<slot>.enabled` on the section. Replaces the legacy
 * `showKickerLines` / `showSubtitleLines` boolean fields (still read for
 * back-compat by the storefront).
 *
 * Ahmad 2026-05-20: "i want them by each section and per each part of it
 * as the Heading line dividers". This v1 ships the enabled toggles only;
 * the full DividerSettings shape (style/thickness/width/color/spacing) is
 * stored + zod-accepted but uses defaults for rendering. v2 will add
 * per-slot styling controls.
 */
/**
 * Lightweight SectionCard for the 3 new sections folded into page-builder
 * 2026-05-20: Brand Story, Trust Strip, Blog carousel. Each shares the
 * same shape — enabled toggle + bg color + dividers + a small live preview.
 * Doesn't expose full typography overrides yet (storefront components
 * don't currently consume per-section typography for these surfaces);
 * extend in v3 if merchants ask.
 */
// ---------------------------------------------------------------------------
// Section order (drag-to-reorder) — Ahmad 2026-05-20.
// ---------------------------------------------------------------------------
// All sections that participate in the homepage order. Hero is included so
// merchants who want to anchor a banner at a non-default position can do so.
// Stays in sync with the SectionOrder enum in @ebda/shared StoreLayoutSettings.
type SectionKey =
  | 'hero'
  | 'categories'
  | 'newArrivals'
  | 'bestSellers'
  | 'brandStory'
  | 'blogCarousel'
  | 'trustStrip'
  | 'testimonials';

const ALL_SECTION_KEYS: SectionKey[] = [
  'hero',
  'categories',
  'newArrivals',
  'bestSellers',
  'brandStory',
  'blogCarousel',
  'trustStrip',
  'testimonials',
];

// Human-readable label for each section kind — translated inline via
// t(`sectionLabels.${key}`) at the single call site below.

function SectionOrderCard({
  order,
  onChange,
}: {
  order: SectionKey[] | undefined;
  onChange: (next: SectionKey[]) => void;
}) {
  const t = useT('orders.layout');
  // Resolve current order: merchant-saved value wins; missing keys append at
  // the end so new sections shipped later show up automatically. Unknown keys
  // (from older saves) get filtered out.
  const resolved: SectionKey[] = (() => {
    if (!order || order.length === 0) return ALL_SECTION_KEYS;
    const seen = new Set(order.filter(k => ALL_SECTION_KEYS.includes(k)));
    const tail = ALL_SECTION_KEYS.filter(k => !seen.has(k));
    return [...Array.from(seen), ...tail];
  })();

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIdx = resolved.indexOf(active.id as SectionKey);
    const newIdx = resolved.indexOf(over.id as SectionKey);
    if (oldIdx < 0 || newIdx < 0) return;
    onChange(arrayMove(resolved, oldIdx, newIdx));
  }

  return (
    <section className="rounded-2xl border border-border bg-card p-4 sm:p-5">
      <div className="mb-3">
        <h3 className="text-base font-semibold text-foreground">{t('sectionOrder.title')}</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">{t('sectionOrder.dragHint')}</p>
        <p className="mt-2 rounded-md bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-800">
          {t('sectionOrder.v1Notice')}
        </p>
      </div>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={resolved} strategy={verticalListSortingStrategy}>
          <ul className="space-y-2">
            {resolved.map((key, i) => (
              <SortableSectionRow
                key={key}
                id={key}
                label={t(`sectionLabels.${key}`)}
                index={i + 1}
              />
            ))}
          </ul>
        </SortableContext>
      </DndContext>
    </section>
  );
}

function SortableSectionRow({
  id,
  label,
  index,
}: {
  id: SectionKey;
  label: string;
  index: number;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };
  return (
    <li
      ref={setNodeRef}
      style={style}
      className={`flex items-center gap-3 rounded-lg border border-border bg-background px-3 py-2.5 ${
        isDragging ? 'shadow-md' : ''
      }`}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        className="flex h-6 w-6 cursor-grab items-center justify-center text-muted-foreground hover:text-foreground active:cursor-grabbing"
        aria-label={`Drag to reorder ${label}`}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-4 w-4"
          aria-hidden
        >
          <circle cx="9" cy="6" r="1" />
          <circle cx="15" cy="6" r="1" />
          <circle cx="9" cy="12" r="1" />
          <circle cx="15" cy="12" r="1" />
          <circle cx="9" cy="18" r="1" />
          <circle cx="15" cy="18" r="1" />
        </svg>
      </button>
      <span className="text-xs font-medium text-muted-foreground tabular-nums">{index}.</span>
      <span className="flex-1 text-sm font-medium text-foreground">{label}</span>
    </li>
  );
}

/**
 * Manual product picker — used by ExtraCarouselCard when productSource ===
 * 'manual'. Search input + result dropdown + selected-pills row with
 * up/down reorder + remove buttons. Calls the store-scoped product list
 * endpoint /api/v1/stores/:storeId/products?search=... + the `ids` param to
 * hydrate names for already-selected products on mount.
 */
interface ProductSummary {
  id: string;
  name: string;
  nameAr?: string | null;
  sku?: string | null;
  images?: Array<{ url: string }>;
}

// Module-level cache for product details (id → summary). Survives across
// renders + across ExtraCarouselCard instances within the same admin session.
// Avoids re-fetching names for already-known products every time merchant
// opens the page-builder or expands a different extra card. Cleared on hard
// reload only — that's fine, fresh data after refresh is the cheap path.
const PRODUCT_DETAIL_CACHE = new Map<string, ProductSummary>();

function ManualProductPicker({
  storeId,
  value,
  onChange,
}: {
  storeId: string;
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  const t = useT('orders.layout');
  const [search, setSearch] = useState('');
  const [searchResults, setSearchResults] = useState<ProductSummary[]>([]);
  // Seed from the module-level cache so already-known products render their
  // names + thumbs on first paint without any fetch (eliminates the flash-of-id
  // when the merchant opens page-builder a second time in the same session).
  const [selectedDetails, setSelectedDetails] = useState<Record<string, ProductSummary>>(() => {
    const seed: Record<string, ProductSummary> = {};
    for (const id of value) {
      const cached = PRODUCT_DETAIL_CACHE.get(id);
      if (cached) seed[id] = cached;
    }
    return seed;
  });
  const [highlightIdx, setHighlightIdx] = useState(0);
  const [isSearching, setIsSearching] = useState(false);
  const [open, setOpen] = useState(false);

  // Hydrate names for IDs we don't have cached yet. Reads from PRODUCT_DETAIL_CACHE
  // first (free); falls through to a single batched fetch for the remainder.
  useEffect(() => {
    const missing = value.filter(id => !selectedDetails[id] && !PRODUCT_DETAIL_CACHE.has(id));
    if (missing.length === 0) {
      // All ids known via cache — populate state from cache if needed.
      const next: Record<string, ProductSummary> = { ...selectedDetails };
      let changed = false;
      for (const id of value) {
        if (!next[id] && PRODUCT_DETAIL_CACHE.has(id)) {
          next[id] = PRODUCT_DETAIL_CACHE.get(id)!;
          changed = true;
        }
      }
      if (changed) setSelectedDetails(next);
      return;
    }
    (async () => {
      try {
        const res = await apiGet<{
          products?: ProductSummary[];
          data?: { products?: ProductSummary[] };
        }>(`/api/v1/stores/${storeId}/products?ids=${missing.join(',')}&limit=50`);
        const list =
          res.data?.products ?? (res.data as { products?: ProductSummary[] })?.products ?? [];
        const next: Record<string, ProductSummary> = { ...selectedDetails };
        for (const p of list) {
          next[p.id] = p;
          PRODUCT_DETAIL_CACHE.set(p.id, p);
        }
        setSelectedDetails(next);
      } catch {
        // silent — picker stays functional with id-only display fallback
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, storeId]);

  // Debounced search.
  useEffect(() => {
    const q = search.trim();
    if (!q) {
      setSearchResults([]);
      setIsSearching(false);
      return;
    }
    setIsSearching(true);
    const t = setTimeout(async () => {
      try {
        const res = await apiGet<{
          products?: ProductSummary[];
          data?: { products?: ProductSummary[] };
        }>(`/api/v1/stores/${storeId}/products?search=${encodeURIComponent(q)}&limit=10`);
        const list =
          res.data?.products ?? (res.data as { products?: ProductSummary[] })?.products ?? [];
        // Cache search-result details so a later "remove + re-add" doesn't
        // re-fetch the same product.
        for (const p of list) PRODUCT_DETAIL_CACHE.set(p.id, p);
        setSearchResults(list);
        setHighlightIdx(0);
      } catch {
        setSearchResults([]);
      } finally {
        setIsSearching(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [search, storeId]);

  function add(id: string, summary?: ProductSummary) {
    if (value.includes(id)) return;
    if (value.length >= 50) {
      alert(t('manualPicker.maxProductsAlert'));
      return;
    }
    if (summary) {
      setSelectedDetails(prev => ({ ...prev, [id]: summary }));
    }
    onChange([...value, id]);
    setSearch('');
    setSearchResults([]);
    setOpen(false);
  }

  function remove(id: string) {
    onChange(value.filter(v => v !== id));
  }

  function move(idx: number, delta: -1 | 1) {
    const target = idx + delta;
    if (target < 0 || target >= value.length) return;
    const next = [...value];
    [next[idx], next[target]] = [next[target], next[idx]];
    onChange(next);
  }

  return (
    <div className="space-y-2">
      {/* Selected products list */}
      {value.length > 0 && (
        <ul className="space-y-1.5">
          {value.map((id, idx) => {
            const detail = selectedDetails[id];
            return (
              <li
                key={id}
                className="flex items-center gap-2 rounded-lg border border-border bg-background px-2 py-1.5"
              >
                {detail?.images?.[0]?.url ? (
                  <img
                    src={detail.images[0].url}
                    alt=""
                    className="h-8 w-8 shrink-0 rounded object-cover"
                  />
                ) : (
                  <div className="h-8 w-8 shrink-0 rounded bg-muted" />
                )}
                <div className="flex-1 min-w-0">
                  <p className="truncate text-xs font-medium text-foreground">
                    {detail?.name || id}
                  </p>
                  {detail?.sku && (
                    <p className="truncate text-[10px] text-muted-foreground">
                      {t('manualPicker.skuPrefix', { sku: detail.sku })}
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  disabled={idx === 0}
                  onClick={() => move(idx, -1)}
                  className="touch-target rounded text-muted-foreground hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed"
                  aria-label={t('manualPicker.moveUp')}
                >
                  ↑
                </button>
                <button
                  type="button"
                  disabled={idx === value.length - 1}
                  onClick={() => move(idx, 1)}
                  className="touch-target rounded text-muted-foreground hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed"
                  aria-label={t('manualPicker.moveDown')}
                >
                  ↓
                </button>
                <button
                  type="button"
                  onClick={() => remove(id)}
                  className="touch-target rounded text-destructive-ink hover:bg-destructive/10"
                  aria-label={t('manualPicker.remove')}
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {/* Search input + results dropdown */}
      <div className="relative">
        <input
          type="text"
          value={search}
          onChange={e => {
            setSearch(e.target.value);
            setOpen(true);
            setHighlightIdx(0);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={e => {
            const filtered = searchResults.filter(p => !value.includes(p.id));
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setHighlightIdx(i => Math.min(i + 1, Math.max(0, filtered.length - 1)));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setHighlightIdx(i => Math.max(i - 1, 0));
            } else if (e.key === 'Enter') {
              const pick = filtered[highlightIdx];
              if (pick) {
                e.preventDefault();
                add(pick.id, pick);
              }
            } else if (e.key === 'Escape') {
              setOpen(false);
            }
          }}
          placeholder={t('manualPicker.searchPlaceholder', { current: value.length, max: 50 })}
          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-base sm:text-sm"
        />
        {open && (search.trim() !== '' || searchResults.length > 0) && (
          <div className="absolute z-20 mt-1 max-h-72 w-full overflow-y-auto rounded-lg border border-border bg-card shadow-lg">
            {isSearching && (
              <div className="px-3 py-2 text-xs text-muted-foreground">
                {t('manualPicker.searching')}
              </div>
            )}
            {!isSearching && searchResults.length === 0 && search.trim() !== '' && (
              <div className="px-3 py-2 text-xs text-muted-foreground">
                {t('manualPicker.noMatches')}
              </div>
            )}
            {searchResults
              .filter(p => !value.includes(p.id))
              .map((p, i) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => add(p.id, p)}
                  onMouseEnter={() => setHighlightIdx(i)}
                  className={`flex w-full items-center gap-2 px-3 py-2 text-start ${
                    i === highlightIdx ? 'bg-muted' : 'hover:bg-muted'
                  }`}
                >
                  {p.images?.[0]?.url ? (
                    <img
                      src={p.images[0].url}
                      alt=""
                      className="h-8 w-8 shrink-0 rounded object-cover"
                    />
                  ) : (
                    <div className="h-8 w-8 shrink-0 rounded bg-muted" />
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="truncate text-xs font-medium text-foreground">{p.name}</p>
                    {p.sku && (
                      <p className="truncate text-[10px] text-muted-foreground">
                        {t('manualPicker.skuPrefix', { sku: p.sku })}
                      </p>
                    )}
                  </div>
                </button>
              ))}
          </div>
        )}
        {(search.trim() !== '' || searchResults.length > 0) && (
          <p className="mt-1 text-[10px] text-muted-foreground/70">
            {t('manualPicker.keyboardHint')}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Section-duplication card — Ahmad 2026-05-20. One per entry in
 * `layout.extraCarousels`. Renders the minimum-viable controls: source
 * picker, title/kicker/subtitle text, limit, bgColor, dividers, padding.
 * Plus a delete button. Reuses the existing SectionDividersBlock +
 * SectionPaddingMaxWidthBlock helpers for visual parity with the static
 * section cards.
 */
function ExtraCarouselCard({
  storeId,
  extra,
  index,
  total,
  onPatch,
  onDelete,
  onMove,
  theme,
}: {
  storeId: string;
  extra: import('@ebda/shared').ExtraCarouselSettings;
  index: number;
  total: number;
  onPatch: (patch: Partial<import('@ebda/shared').ExtraCarouselSettings>) => void;
  onDelete: () => void;
  onMove: (delta: -1 | 1) => void;
  theme: import('@ebda/shared').StoreTheme;
}) {
  const t = useT('orders.layout');
  const enabled = extra.enabled !== false;
  const dividerValues = {
    dividers: extra.dividers,
    showKickerLines: extra.showKickerLines ?? true,
    showSubtitleLines: extra.showSubtitleLines ?? true,
  };
  return (
    <SectionCard
      title={extra.title || t('extraCarousel.defaultTitle', { n: index + 1 })}
      description={t('extraCarousel.sourceDescription', { source: extra.productSource })}
      enabled={enabled}
      onToggle={v => onPatch({ enabled: v })}
      defaultExpanded={false}
    >
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">
              {t('extraCarousel.titleEn')}
            </span>
            <input
              type="text"
              value={extra.title ?? ''}
              onChange={e => onPatch({ title: e.target.value })}
              placeholder="e.g. Editor's Picks"
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-base sm:text-sm"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">
              {t('extraCarousel.titleAr')}
            </span>
            <input
              type="text"
              value={extra.titleAr ?? ''}
              onChange={e => onPatch({ titleAr: e.target.value })}
              placeholder="مثال: اختيارات المحرر"
              dir="rtl"
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-base sm:text-sm"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">
              {t('extraCarousel.subtitleEn')}
            </span>
            <input
              type="text"
              value={extra.subtitle ?? ''}
              onChange={e => onPatch({ subtitle: e.target.value })}
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-base sm:text-sm"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">
              {t('extraCarousel.subtitleAr')}
            </span>
            <input
              type="text"
              value={extra.subtitleAr ?? ''}
              onChange={e => onPatch({ subtitleAr: e.target.value })}
              dir="rtl"
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-base sm:text-sm"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">
              {t('extraCarousel.productSourceLabel')}
            </span>
            <select
              value={extra.productSource}
              onChange={e =>
                onPatch({
                  productSource: e.target.value as import('@ebda/shared').ExtraCarouselSource,
                })
              }
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
            >
              <option value="newest">{t('extraCarousel.sourceNewest')}</option>
              <option value="best_seller">{t('extraCarousel.sourceBestSellers')}</option>
              <option value="featured">{t('extraCarousel.sourceFeatured')}</option>
              <option value="on_sale">{t('extraCarousel.sourceOnSale')}</option>
              <option value="reorder">{t('extraCarousel.sourceReorder')}</option>
              <option value="category">{t('extraCarousel.sourceCategory')}</option>
              <option value="manual">{t('extraCarousel.sourceManual')}</option>
            </select>
          </label>
          {extra.productSource === 'category' && (
            <>
              <label className="flex flex-col gap-1 sm:col-span-2">
                <span className="text-xs font-medium text-muted-foreground">
                  {t('extraCarousel.categorySlugLabel')}
                </span>
                <input
                  type="text"
                  value={extra.categorySlug ?? ''}
                  onChange={e => onPatch({ categorySlug: e.target.value || undefined })}
                  placeholder="exact slug as in /products?category=<slug>"
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-base sm:text-sm"
                />
              </label>
              <label className="flex flex-col gap-1 sm:col-span-2">
                <span className="text-xs font-medium text-muted-foreground">
                  {t('extraCarousel.categoryFetchLimitLabel')}
                </span>
                <input
                  type="number"
                  min={1}
                  max={200}
                  value={extra.categoryFetchLimit ?? 50}
                  onChange={e => {
                    const v = Number(e.target.value);
                    onPatch({
                      categoryFetchLimit:
                        Number.isFinite(v) && v >= 1 && v <= 200 && v !== 50 ? v : undefined,
                    });
                  }}
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm w-32"
                />
                <span className="mt-0.5 text-[11px] text-muted-foreground/80">
                  {t('extraCarousel.categoryFetchLimitHint')}
                </span>
              </label>
            </>
          )}
          {extra.productSource === 'manual' && (
            <div className="sm:col-span-2 flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">
                {t('extraCarousel.manualProductsLabel')}
              </span>
              <ManualProductPicker
                storeId={storeId}
                value={extra.manualProductIds ?? []}
                onChange={ids => onPatch({ manualProductIds: ids.length ? ids : undefined })}
              />
            </div>
          )}
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">
              {t('extraCarousel.maxProductsLabel')}
            </span>
            <input
              type="number"
              min={1}
              max={50}
              value={extra.limit ?? 12}
              onChange={e => onPatch({ limit: Number(e.target.value) || 12 })}
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm w-32"
            />
          </label>
          <label className="flex flex-col gap-1 sm:col-span-2">
            <span className="text-xs font-medium text-muted-foreground">
              {t('extraCarousel.backgroundColorLabel')}
            </span>
            <input
              type="text"
              value={extra.bgColor ?? ''}
              onChange={e => onPatch({ bgColor: e.target.value || undefined })}
              placeholder="#FFFFFF or token:primary or leave empty"
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-base sm:text-sm"
            />
          </label>
        </div>
        <SectionDividersBlock
          values={dividerValues}
          onPatch={patch => {
            if (patch.dividers) onPatch({ dividers: patch.dividers });
          }}
          theme={theme}
        />
        <SectionPaddingMaxWidthBlock values={extra} onPatch={p => onPatch(p)} />
        <SectionPreview
          label={extra.title || `Extra ${index + 1}`}
          bgColor={extra.bgColor}
          cardFrameColor={extra.cardFrameColor}
          cardFrameWidth={extra.cardFrameWidth}
          cardFrameSize={extra.cardFrameSize}
          headingZone={extra.typography?.heading}
          kickerZone={extra.typography?.kicker}
          subtitleZone={extra.typography?.subtitle}
          titleText={extra.title}
          kickerText={extra.kicker}
          subtitleText={extra.subtitle}
          dividers={extra.dividers}
          theme={theme}
        />
        <div className="border-t border-border pt-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {t('extraCarousel.positionOfTotal', { position: index + 1, total })}
            </span>
            <button
              type="button"
              disabled={index === 0}
              onClick={() => onMove(-1)}
              className="rounded-lg border border-border px-2.5 py-1.5 text-xs font-semibold text-foreground hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed"
              aria-label={t('extraCarousel.moveUp')}
            >
              {t('extraCarousel.moveUp')}
            </button>
            <button
              type="button"
              disabled={index === total - 1}
              onClick={() => onMove(1)}
              className="rounded-lg border border-border px-2.5 py-1.5 text-xs font-semibold text-foreground hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed"
              aria-label={t('extraCarousel.moveDown')}
            >
              {t('extraCarousel.moveDown')}
            </button>
          </div>
          <button
            type="button"
            onClick={() => {
              if (
                confirm(
                  t('extraCarousel.deleteConfirm', {
                    suffix: extra.title ? ` ("${extra.title}")` : '',
                  })
                )
              ) {
                onDelete();
              }
            }}
            className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-1.5 text-xs font-semibold text-destructive-ink hover:bg-destructive/10"
          >
            {t('extraCarousel.deleteButton')}
          </button>
        </div>
      </div>
    </SectionCard>
  );
}

function ExtraSectionCard({
  kind,
  label,
  description,
  settings,
  legacyEnabled,
  onPatch,
  theme,
  typographyZones,
  globalZones,
  onZonePatch,
  onZoneReset,
  children,
}: {
  kind: 'brandStory' | 'trustStrip' | 'blogCarousel' | 'announcement' | 'header' | 'footer';
  label: string;
  description: string;
  settings:
    | import('@ebda/shared').BrandStorySettings
    | import('@ebda/shared').TrustStripSettings
    | import('@ebda/shared').BlogCarouselSettings
    | import('@ebda/shared').AnnouncementSectionSettings
    | import('@ebda/shared').HeaderSettings
    | import('@ebda/shared').FooterSettings
    | undefined;
  legacyEnabled: boolean;
  onPatch: (
    patch: Partial<
      import('@ebda/shared').BrandStorySettings &
        import('@ebda/shared').TrustStripSettings &
        import('@ebda/shared').BlogCarouselSettings &
        import('@ebda/shared').AnnouncementSectionSettings &
        import('@ebda/shared').HeaderSettings &
        import('@ebda/shared').FooterSettings
    >
  ) => void;
  theme: import('@ebda/shared').StoreTheme;
  /** Optional list of platform-wide typography zone keys to expose inside
   *  this card. Used by Header (['beforeHeader','header','storeName']) and
   *  Footer (['footer','afterFooter']) — replaces the deleted
   *  platform-wide Header+Footer Typography card 2026-05-20. */
  typographyZones?: string[];
  globalZones?: Record<string, import('@ebda/shared').ZoneOverride>;
  onZonePatch?: (zoneKey: string, next: Partial<import('@ebda/shared').ZoneOverride>) => void;
  onZoneReset?: (zoneKey: string) => void;
  /** Extra content rendered at the bottom of the card body — used to fold the
   *  Footer links editor into the same Footer card (one card, one Save). */
  children?: React.ReactNode;
}) {
  const t = useT('orders.layout');
  const enabled = settings?.enabled ?? legacyEnabled;
  // KickerSubtitleValues shape used by SectionDividersBlock — these sections
  // don't have kicker/subtitle fields, but the divider block only reads
  // values.dividers, so we wrap with empty placeholders.
  const dividerValues = {
    dividers: settings?.dividers,
    showKickerLines: true,
    showSubtitleLines: true,
  };
  return (
    <SectionCard
      title={label}
      description={description}
      enabled={enabled}
      onToggle={v => onPatch({ enabled: v })}
      defaultExpanded={false}
    >
      <div className="space-y-4">
        <ColorField
          label={t('extraSection.backgroundColorLabel')}
          value={settings?.bgColor}
          onChange={v => onPatch({ bgColor: v })}
          theme={theme}
        />
        {kind === 'trustStrip' && (
          <>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">
                {t('extraSection.layoutLabel')}
              </span>
              <select
                value={
                  (settings as import('@ebda/shared').TrustStripSettings | undefined)?.layout ??
                  'horizontal'
                }
                onChange={e => onPatch({ layout: e.target.value as 'horizontal' | 'vertical' })}
                className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
              >
                <option value="horizontal">{t('extraSection.layoutHorizontal')}</option>
                <option value="vertical">{t('extraSection.layoutVertical')}</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">
                {t('extraSection.sizeLabel')}
              </span>
              <select
                value={
                  (settings as import('@ebda/shared').TrustStripSettings | undefined)?.size ?? 'md'
                }
                onChange={e => onPatch({ size: e.target.value as 'sm' | 'md' | 'lg' })}
                className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
              >
                <option value="sm">{t('common.small')}</option>
                <option value="md">{t('common.medium')}</option>
                <option value="lg">{t('common.large')}</option>
              </select>
            </label>
            <ColorField
              label={t('extraSection.iconColorLabel')}
              value={(settings as import('@ebda/shared').TrustStripSettings | undefined)?.iconColor}
              onChange={v => onPatch({ iconColor: v })}
              theme={theme}
            />
            <ColorField
              label={t('extraSection.iconBgColorLabel')}
              value={
                (settings as import('@ebda/shared').TrustStripSettings | undefined)?.iconBgColor
              }
              onChange={v => onPatch({ iconBgColor: v })}
              theme={theme}
            />
            <ColorField
              label={t('extraSection.textColorLabel')}
              value={(settings as import('@ebda/shared').TrustStripSettings | undefined)?.textColor}
              onChange={v => onPatch({ textColor: v })}
              theme={theme}
            />
          </>
        )}
        {kind === 'blogCarousel' && (
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">
              {t('extraSection.maxPostsLabel')}
            </span>
            <input
              type="number"
              min={1}
              max={20}
              value={
                (settings as import('@ebda/shared').BlogCarouselSettings | undefined)?.limit ?? 6
              }
              onChange={e => onPatch({ limit: Number(e.target.value) || 6 })}
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm w-32"
            />
          </label>
        )}
        <SectionDividersBlock
          values={dividerValues}
          onPatch={patch => {
            if (patch.dividers) onPatch({ dividers: patch.dividers });
          }}
          theme={theme}
          // Audit fix 2026-05-20: Header/Footer/Announcement/BrandStory/
          // TrustStrip/BlogCarousel don't render a SectionHeading with
          // kicker/title/subtitle, so those toggles would be decorative.
          // Restrict to the slots that actually flow through to storefront.
          availableSlots={
            kind === 'header' || kind === 'footer' || kind === 'announcement'
              ? ['above']
              : ['above', 'belowHeading']
          }
        />
        <SectionPaddingMaxWidthBlock values={settings} onPatch={p => onPatch(p)} />
        {typographyZones && typographyZones.length > 0 && globalZones && onZonePatch && (
          <div className="rounded-lg border border-dashed border-border bg-muted/20 p-3">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {t('extraSection.typographyLabel')}
            </p>
            <div className="space-y-3">
              {typographyZones.map(zoneKey => (
                <ZoneEditor
                  key={zoneKey}
                  zoneKey={zoneKey}
                  zoneLabel={
                    (
                      {
                        beforeHeader: t('zoneLabels.beforeHeader'),
                        header: t('zoneLabels.header'),
                        storeName: t('zoneLabels.storeName'),
                        sectionKicker: t('zoneLabels.sectionKicker'),
                        sectionTitle: t('zoneLabels.sectionTitle'),
                        sectionSubtitle: t('zoneLabels.sectionSubtitle'),
                        sectionSeeAll: t('zoneLabels.sectionSeeAll'),
                        categories: t('zoneLabels.categories'),
                        products: t('zoneLabels.products'),
                        productName: t('zoneLabels.productName'),
                        productPrice: t('zoneLabels.productPrice'),
                        cta: t('zoneLabels.cta'),
                        filters: t('zoneLabels.filters'),
                        footer: t('zoneLabels.footer'),
                        afterFooter: t('zoneLabels.afterFooter'),
                      } as Record<string, string>
                    )[zoneKey] ?? zoneKey
                  }
                  values={globalZones[zoneKey] ?? {}}
                  onChange={next => onZonePatch(zoneKey, next)}
                  onReset={onZoneReset ? () => onZoneReset(zoneKey) : undefined}
                  theme={theme}
                />
              ))}
            </div>
          </div>
        )}
        <SectionPreview
          label={label}
          bgColor={settings?.bgColor}
          cardFrameColor={undefined}
          cardFrameWidth={undefined}
          headingZone={undefined}
          dividers={settings?.dividers}
          // Audit fix: these sections don't render product cards on the
          // storefront — hide the mock 3-card grid in the preview tile.
          hideCards
          theme={theme}
        />
        {children}
      </div>
    </SectionCard>
  );
}

/**
 * Per-section padding / max-width / breakpoint visibility controls — item #6
 * of the page-builder gap fill. 5 fields rendered inline so any section card
 * (existing or new) can host them via one component invocation.
 */
function SectionPaddingMaxWidthBlock({
  values,
  onPatch,
}: {
  values: import('@ebda/shared').SectionPaddingMaxWidthVisibility | undefined;
  onPatch: (patch: Partial<import('@ebda/shared').SectionPaddingMaxWidthVisibility>) => void;
}) {
  const t = useT('orders.layout');
  return (
    <div className="rounded-lg border border-dashed border-border bg-muted/20 p-3">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {t('paddingBlock.title')}
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <DividerStyleSelect
          label={t('paddingBlock.paddingTopLabel')}
          value={values?.paddingTop ?? 'normal'}
          options={[
            ['none', t('paddingBlock.optNone')],
            ['tight', t('paddingBlock.optTight')],
            ['normal', t('paddingBlock.optNormal')],
            ['loose', t('paddingBlock.optLoose')],
            ['xloose', t('paddingBlock.optXloose')],
          ]}
          onChange={v => onPatch({ paddingTop: v as 'normal' })}
        />
        <DividerStyleSelect
          label={t('paddingBlock.paddingBottomLabel')}
          value={values?.paddingBottom ?? 'normal'}
          options={[
            ['none', t('paddingBlock.optNone')],
            ['tight', t('paddingBlock.optTight')],
            ['normal', t('paddingBlock.optNormal')],
            ['loose', t('paddingBlock.optLoose')],
            ['xloose', t('paddingBlock.optXloose')],
          ]}
          onChange={v => onPatch({ paddingBottom: v as 'normal' })}
        />
        <DividerStyleSelect
          label={t('paddingBlock.maxWidthLabel')}
          value={values?.maxWidth ?? 'contained'}
          options={[
            ['contained', t('paddingBlock.maxWidthContained')],
            ['full', t('paddingBlock.maxWidthFull')],
          ]}
          onChange={v => onPatch({ maxWidth: v as 'contained' })}
        />
      </div>
      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <RowToggle
          label={t('paddingBlock.hideOnMobile')}
          checked={values?.hideOnMobile === true}
          onChange={v => onPatch({ hideOnMobile: v })}
        />
        <RowToggle
          label={t('paddingBlock.hideOnDesktop')}
          checked={values?.hideOnDesktop === true}
          onChange={v => onPatch({ hideOnDesktop: v })}
        />
      </div>
    </div>
  );
}

interface SlidesEditorProps {
  slides: HeroSlide[];
  storeId: string;
  storeTemplate: TemplateId | undefined;
  onChange: (next: HeroSlide[]) => void;
}

function SlidesEditor({ slides, storeId, storeTemplate, onChange }: SlidesEditorProps) {
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
      {
        image: '',
        alt: '',
        headline: '',
        headlineAr: '',
        ctaText: '',
        ctaTextAr: '',
        ctaHref: '',
        link: '',
      },
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
                    recommendedSizeHint={recommendedSizeTextForTemplate(
                      'heroDesktop',
                      storeTemplate
                    )}
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
                      recommendedSizeHint={recommendedSizeTextForTemplate(
                        'heroDesktop',
                        storeTemplate
                      )}
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
                    onUpload={url => updateSlide(index, { imageMobile: url })}
                    onRemove={() => updateSlide(index, { imageMobile: '' })}
                    recommendedSizeHint={recommendedSizeTextForTemplate(
                      'heroMobile',
                      storeTemplate
                    )}
                  />
                  <div className="mt-3">
                    <label className="mb-1 block text-[10px] uppercase tracking-wider text-muted-foreground">
                      {t('imageMobileAr')}
                    </label>
                    <ImageUpload
                      value={slide.imageMobileAr || undefined}
                      folder="hero"
                      storeId={storeId}
                      onUpload={url => updateSlide(index, { imageMobileAr: url })}
                      onRemove={() => updateSlide(index, { imageMobileAr: '' })}
                      recommendedSizeHint={recommendedSizeTextForTemplate(
                        'heroMobile',
                        storeTemplate
                      )}
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
                <TextField
                  label={t('link')}
                  placeholder={t('linkPlaceholder')}
                  value={slide.link ?? ''}
                  onChange={v => updateSlide(index, { link: v })}
                />
                {/* Image focus for the cropped hero (Ruling B1-32): keeps a head in frame. */}
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-muted-foreground">{t('focus')}</span>
                  <select
                    value={slide.focus ?? 'center'}
                    onChange={e =>
                      updateSlide(index, {
                        focus: e.target.value as 'top' | 'center' | 'bottom',
                      })
                    }
                    className="rounded-lg border border-border bg-card px-3 py-2 text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                  >
                    <option value="center">{t('focusCenter')}</option>
                    <option value="top">{t('focusTop')}</option>
                    <option value="bottom">{t('focusBottom')}</option>
                  </select>
                </label>
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
      ? 'border-destructive/40 text-destructive-ink hover:bg-destructive/10'
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

// ---------------------------------------------------------------------------
// Divider helper components — extracted to keep the SectionCard JSX readable.
// These mirror the standalone /dividers page's ControlGroup + RadioPicker +
// DividerPreview components verbatim so the UX is identical in both places.
// The standalone page was merged into page-builder on 2026-05-19.
// ---------------------------------------------------------------------------
