'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { useLocale } from 'next-intl';
import Link from 'next/link';
import { Button, useToast } from '@force/ui';
import { AdminLayout } from '../../../../components/AdminLayout';
import { apiGet, apiPut, apiFetch } from '../../../../lib/api';

// Typography is store-scoped and template-agnostic — the storefront's
// data-zone wrappers in ShopChrome (and the in-template grid wrappers)
// catch the same six zones regardless of which pack the merchant has
// active. Keep this UI in lock-step with the Zod schema in
// apps/api/src/routes/typography.routes.ts.

// Inherited / baseline values per zone — these are the typical defaults
// across the 5 packs (Modern / Classic / Minimal / Bold / Elegant). They
// vary slightly per template, but the numbers below are the common
// starting points so the merchant can see what they're overriding
// before they type a new value. Leaving a field blank inherits from
// the active template's CSS.
interface ZoneDef {
  key: ZoneKey;
  label: string;
  labelAr: string;
  description: string;
  descriptionAr: string;
  defaults: { fontSize: string; fontWeight: string; lineHeight: string };
  /** Marks the row visually as a sub-zone (rendered as a nested
   *  override of one of the broad zones). */
  isSubZone?: boolean;
}

const ZONES: ZoneDef[] = [
  // Broad zones — wrap whole storefront regions.
  {
    key: 'beforeHeader',
    label: 'Before header (announcement bar)',
    labelAr: 'قبل الهيدر (شريط الإعلان)',
    description: 'The thin promo strip above the header.',
    descriptionAr: 'الشريط الإعلاني فوق الهيدر.',
    defaults: { fontSize: '14px (0.875rem)', fontWeight: '500', lineHeight: '1.5' },
  },
  {
    key: 'header',
    label: 'Header',
    labelAr: 'الهيدر',
    description: 'Logo, navigation, search, cart icons.',
    descriptionAr: 'الشعار، القائمة، البحث، أيقونات السلة.',
    defaults: { fontSize: '16px (1rem)', fontWeight: '500', lineHeight: '1.5' },
  },
  {
    key: 'categories',
    label: 'Categories',
    labelAr: 'الفئات',
    description: 'The categories grid / strip on the homepage.',
    descriptionAr: 'شبكة / شريط الفئات على الصفحة الرئيسية.',
    defaults: { fontSize: '24px (1.5rem)', fontWeight: '600', lineHeight: '1.25' },
  },
  {
    key: 'products',
    label: 'Products',
    labelAr: 'المنتجات',
    description: 'Whole product surfaces — listing, detail, recommendations.',
    descriptionAr: 'كل صفحات المنتجات — القائمة، التفاصيل، التوصيات.',
    defaults: { fontSize: '16px (1rem)', fontWeight: '500', lineHeight: '1.5' },
  },
  {
    key: 'footer',
    label: 'Footer',
    labelAr: 'الفوتر',
    description: 'Footer columns, links, copyright row.',
    descriptionAr: 'أعمدة الفوتر والروابط وسطر حقوق النشر.',
    defaults: { fontSize: '14px (0.875rem)', fontWeight: '400', lineHeight: '1.5' },
  },
  {
    key: 'afterFooter',
    label: 'After footer',
    labelAr: 'بعد الفوتر',
    description: 'Anything appended below the footer (cookie strip, etc.).',
    descriptionAr: 'أي عنصر يظهر تحت الفوتر (شريط الكوكيز إلخ).',
    defaults: { fontSize: '12px (0.75rem)', fontWeight: '400', lineHeight: '1.4' },
  },
  // Sub-zones — nested overrides.
  {
    key: 'sectionTitle',
    label: 'Section title',
    labelAr: 'عنوان القسم',
    description: 'Homepage section H2s ("New Arrivals", "Shop by Category") + listing-page H1.',
    descriptionAr:
      'عناوين أقسام الصفحة الرئيسية ("أحدث المنتجات"، "تسوق حسب الفئة") وعنوان صفحة القائمة.',
    defaults: { fontSize: '28px (1.75rem)', fontWeight: '700', lineHeight: '1.2' },
    isSubZone: true,
  },
  {
    key: 'productName',
    label: 'Product name',
    labelAr: 'اسم المنتج',
    description: 'Just the product name on a card. Overrides the broader "Products" font.',
    descriptionAr: 'اسم المنتج فقط على البطاقة. يتجاوز إعدادات منطقة "المنتجات" الأشمل.',
    defaults: { fontSize: '16px (1rem)', fontWeight: '600', lineHeight: '1.3' },
    isSubZone: true,
  },
  {
    key: 'productPrice',
    label: 'Product price',
    labelAr: 'سعر المنتج',
    description: 'Just the price text on a product card.',
    descriptionAr: 'نص السعر فقط على بطاقة المنتج.',
    defaults: { fontSize: '16px (1rem)', fontWeight: '700', lineHeight: '1.2' },
    isSubZone: true,
  },
  {
    key: 'cta',
    label: 'Buttons / CTAs',
    labelAr: 'الأزرار',
    description: '"Add to cart", "Subscribe", "View store", and similar action buttons.',
    descriptionAr: 'أزرار "أضف للسلة"، "اشترك"، "عرض المتجر"، وما شابه.',
    defaults: { fontSize: '14px (0.875rem)', fontWeight: '500', lineHeight: '1.2' },
    isSubZone: true,
  },
  {
    key: 'filters',
    label: 'Filters',
    labelAr: 'الفلاتر',
    description: 'Filter sidebar on /products — sort, search, price range, category chips.',
    descriptionAr: 'الشريط الجانبي للفلاتر — الترتيب، البحث، مجال السعر، رقاقات الفئات.',
    defaults: { fontSize: '14px (0.875rem)', fontWeight: '500', lineHeight: '1.4' },
    isSubZone: true,
  },
];

type ZoneKey =
  | 'beforeHeader'
  | 'header'
  | 'categories'
  | 'products'
  | 'footer'
  | 'afterFooter'
  | 'sectionTitle'
  | 'productName'
  | 'productPrice'
  | 'cta'
  | 'filters';

interface ZoneSettings {
  fontFamily?: string;
  fontSize?: string;
  fontWeight?: string;
  color?: string;
  lineHeight?: string;
  letterSpacing?: string;
}

type FontSource =
  | { type: 'google'; url: string; family: string }
  | {
      type: 'custom';
      family: string;
      url: string;
      format: 'woff2' | 'woff' | 'ttf' | 'otf';
      weight?: string;
      style?: 'normal' | 'italic';
    };

interface Typography {
  fonts: FontSource[];
  zones: Partial<Record<ZoneKey, ZoneSettings>>;
}

const EMPTY: Typography = { fonts: [], zones: {} };

// Common Google font picks shown as quick-add suggestions. The merchant
// can also paste any other CSS URL from fonts.google.com.
const QUICK_GOOGLE_FONTS: Array<{ family: string; url: string }> = [
  {
    family: 'Inter',
    url: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap',
  },
  {
    family: 'Playfair Display',
    url: 'https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700&display=swap',
  },
  {
    family: 'Cairo',
    url: 'https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700&display=swap',
  },
  {
    family: 'Tajawal',
    url: 'https://fonts.googleapis.com/css2?family=Tajawal:wght@400;500;700&display=swap',
  },
  {
    family: 'Poppins',
    url: 'https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap',
  },
  {
    family: 'Lora',
    url: 'https://fonts.googleapis.com/css2?family=Lora:wght@400;600;700&display=swap',
  },
];

export default function TypographyPage() {
  const params = useParams();
  const locale = useLocale();
  const isAr = locale === 'ar';
  const storeId = params?.id as string;
  const { success: toastSuccess, error: toastError } = useToast();

  const [typo, setTypo] = useState<Typography>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [googleUrlDraft, setGoogleUrlDraft] = useState('');
  const [googleFamilyDraft, setGoogleFamilyDraft] = useState('');
  const [customFamilyDraft, setCustomFamilyDraft] = useState('');
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    if (!storeId) return;
    setLoading(true);
    const { data, error } = await apiGet<{ typography: Typography }>(
      `/api/v1/stores/${storeId}/typography`
    );
    if (!error && data?.typography) {
      setTypo({
        fonts: Array.isArray(data.typography.fonts) ? data.typography.fonts : [],
        zones: data.typography.zones ?? {},
      });
    }
    setLoading(false);
  }, [storeId]);

  useEffect(() => {
    load();
  }, [load]);

  const save = useCallback(
    async (next: Typography) => {
      setSaving(true);
      const { error } = await apiPut<{ typography: Typography }>(
        `/api/v1/stores/${storeId}/typography`,
        next
      );
      setSaving(false);
      if (error) {
        toastError('Save failed', error.message ?? '');
        return false;
      }
      toastSuccess('Typography saved');
      return true;
    },
    [storeId, toastError, toastSuccess]
  );

  // Normalise unit-less numeric inputs into valid CSS. Merchants
  // routinely type "16" thinking the field is a number — but the
  // storefront emits the value verbatim into a CSS rule, and CSS
  // ignores `font-size: 16` entirely. Convert any pure number to
  // pixels; leave anything that already has a unit (px / rem / em /
  // %, calc(), clamp() …) alone.
  const normaliseSize = (raw: string): string => {
    const trimmed = raw.trim();
    if (!trimmed) return trimmed;
    if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return `${trimmed}px`;
    return trimmed;
  };
  const updateZone = (zone: ZoneKey, patch: Partial<ZoneSettings>) => {
    const current = typo.zones[zone] ?? {};
    const merged = { ...current, ...patch };
    const cleaned: ZoneSettings = {};
    for (const [k, v] of Object.entries(merged)) {
      if (typeof v !== 'string') continue;
      const trimmed = v.trim();
      if (!trimmed) continue;
      // Auto-append `px` to bare numbers in the size + spacing fields.
      // fontWeight is unitless, so don't touch it. Color also unitless.
      const final =
        k === 'fontSize' || k === 'lineHeight' || k === 'letterSpacing'
          ? normaliseSize(trimmed)
          : trimmed;
      cleaned[k as keyof ZoneSettings] = final;
    }
    setTypo(t => ({ ...t, zones: { ...t.zones, [zone]: cleaned } }));
  };

  const addGoogleFont = (url: string, family: string) => {
    const u = url.trim();
    const f = family.trim();
    if (!u || !f) return;
    if (typo.fonts.some(font => font.type === 'google' && font.url === u)) return;
    setTypo(t => ({ ...t, fonts: [...t.fonts, { type: 'google', url: u, family: f }] }));
    setGoogleUrlDraft('');
    setGoogleFamilyDraft('');
  };

  const removeFont = (idx: number) => {
    setTypo(t => ({ ...t, fonts: t.fonts.filter((_, i) => i !== idx) }));
  };

  // Apply the chosen family to every zone in one click. Saves the
  // merchant from picking the same dropdown value six times when they
  // just want one font everywhere — the common case.
  const applyFontToAllZones = (family: string) => {
    const applied: Typography['zones'] = {};
    for (const z of ZONES) {
      const existing = typo.zones[z.key] ?? {};
      applied[z.key] = { ...existing, fontFamily: family };
    }
    setTypo(t => ({ ...t, zones: applied }));
    toastSuccess(`Set ${family} on every zone`);
  };

  const onFontFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!customFamilyDraft.trim()) {
      toastError('Family name required', 'Pick a family name before uploading a font file.');
      return;
    }
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await apiFetch(`/api/v1/uploads/font?storeId=${storeId}`, {
        method: 'POST',
        body: form,
      });
      const json = await res.json();
      if (!res.ok || !json?.success) {
        toastError('Upload failed', json?.error?.message ?? `HTTP ${res.status}`);
        return;
      }
      const { url, format } = json.data as {
        url: string;
        format: 'woff2' | 'woff' | 'ttf' | 'otf';
      };
      setTypo(t => ({
        ...t,
        fonts: [...t.fonts, { type: 'custom', family: customFamilyDraft.trim(), url, format }],
      }));
      setCustomFamilyDraft('');
      if (fileInputRef.current) fileInputRef.current.value = '';
      toastSuccess('Font uploaded');
    } finally {
      setUploading(false);
    }
  };

  // Family suggestions for the per-zone family <select>. Merchant-loaded
  // fonts come first, then a small set of system fallbacks they can use
  // even without uploading anything.
  const familyOptions = [
    { value: '', label: 'Inherit from template' },
    ...typo.fonts.map(f => ({
      value: `'${f.family}'`,
      label: `${f.family} (${f.type === 'google' ? 'Google' : 'Custom'})`,
    })),
    { value: 'system-ui, sans-serif', label: 'System UI' },
    { value: 'Georgia, serif', label: 'Georgia (serif)' },
    { value: 'Menlo, monospace', label: 'Menlo (mono)' },
  ];

  return (
    <AdminLayout
      title="Typography"
      subtitle="Per-store font, size, and color overrides for every storefront zone"
      actions={
        <div className="flex gap-2">
          <Link href={`/stores/${storeId}`}>
            <Button type="button" variant="outline">
              Back to Store
            </Button>
          </Link>
          <button
            type="button"
            onClick={() => save(typo)}
            disabled={saving}
            className="px-4 py-2 text-sm bg-primary text-white rounded-lg hover:bg-primary/90 font-medium disabled:opacity-60"
          >
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      }
    >
      {loading ? (
        <div className="rounded-xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
          Loading typography settings…
        </div>
      ) : (
        <div className="space-y-6">
          {/* Fonts library */}
          <section className="rounded-2xl border border-border bg-card p-5">
            <h2 className="text-base font-semibold text-foreground">Fonts library</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Add the fonts you want available on this store. Adding one here only{' '}
              <strong>loads</strong> it on the storefront — it doesn't apply automatically. Use the
              dropdown in each zone below to actually pick a font, or click{' '}
              <em>Apply to all zones</em> on a font to set it everywhere in one click. Both Google
              Fonts URLs and uploaded files (.woff2 / .woff / .ttf / .otf) are supported.
            </p>

            {typo.fonts.length > 0 && (
              <ul className="mt-4 space-y-2">
                {typo.fonts.map((f, i) => (
                  <li
                    key={i}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/60 bg-background px-3 py-2 text-sm"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium text-foreground">{f.family}</div>
                      <div className="truncate text-xs text-muted-foreground">
                        {f.type === 'google' ? 'Google Fonts' : `Custom (${f.format})`} — {f.url}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {/* "Apply to all zones" — most common case is one
                          font everywhere; without this the merchant
                          has to set the same dropdown six times. */}
                      <button
                        type="button"
                        onClick={() => applyFontToAllZones(`'${f.family}'`)}
                        className="rounded-lg border border-primary/40 px-2.5 py-1 text-xs font-medium text-primary hover:bg-primary/5"
                        title="Set this font on every zone"
                      >
                        Apply to all zones
                      </button>
                      <button
                        type="button"
                        onClick={() => removeFont(i)}
                        className="rounded-lg border border-destructive/30 px-2.5 py-1 text-xs font-medium text-destructive hover:bg-destructive/5"
                      >
                        Remove
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            {/* Add Google font */}
            <div className="mt-4 grid gap-3 md:grid-cols-3">
              <input
                type="text"
                placeholder="Family name (e.g. Inter)"
                value={googleFamilyDraft}
                onChange={e => setGoogleFamilyDraft(e.target.value)}
                className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
              />
              <input
                type="url"
                placeholder="Google Fonts CSS URL"
                value={googleUrlDraft}
                onChange={e => setGoogleUrlDraft(e.target.value)}
                className="md:col-span-2 rounded-lg border border-border bg-background px-3 py-2 text-sm"
              />
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => addGoogleFont(googleUrlDraft, googleFamilyDraft)}
                disabled={!googleUrlDraft.trim() || !googleFamilyDraft.trim()}
                className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                Add Google font
              </button>
              <span className="text-xs text-muted-foreground">Quick picks:</span>
              {QUICK_GOOGLE_FONTS.map(g => (
                <button
                  key={g.family}
                  type="button"
                  onClick={() => addGoogleFont(g.url, g.family)}
                  className="rounded-full border border-border px-2.5 py-1 text-xs hover:bg-muted"
                >
                  {g.family}
                </button>
              ))}
            </div>

            {/* Upload custom font */}
            <div className="mt-5 rounded-xl border border-dashed border-border/80 bg-background/40 p-3">
              <div className="grid gap-3 md:grid-cols-2">
                <input
                  type="text"
                  placeholder="Family name (e.g. BrandSans)"
                  value={customFamilyDraft}
                  onChange={e => setCustomFamilyDraft(e.target.value)}
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
                />
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".woff2,.woff,.ttf,.otf,font/woff2,font/woff,font/ttf,font/otf"
                  disabled={uploading || !customFamilyDraft.trim()}
                  onChange={onFontFile}
                  className="text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-primary file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-primary-foreground hover:file:bg-primary/90 disabled:opacity-50"
                />
              </div>
              {uploading && (
                <p className="mt-2 text-xs text-muted-foreground">Uploading font file…</p>
              )}
            </div>
          </section>

          {/* Per-zone controls */}
          <section className="rounded-2xl border border-border bg-card p-5">
            <h2 className="text-base font-semibold text-foreground">Zones</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Each zone wraps a region of every template via the storefront's <code>data-zone</code>{' '}
              attributes. Leave a field blank to inherit from the active template.
            </p>
            <div className="mt-4 space-y-5">
              {ZONES.map((z, i) => {
                const cfg = typo.zones[z.key] ?? {};
                // Insert a subtle divider + header before the first
                // sub-zone so the merchant sees they're a finer-grained
                // override layer on top of the broad zones above.
                const isFirstSubZone = z.isSubZone && !ZONES[i - 1]?.isSubZone;
                return (
                  <div key={z.key}>
                    {isFirstSubZone && (
                      <div className="mb-5 rounded-xl border border-dashed border-border bg-muted/30 p-3 text-xs text-muted-foreground">
                        <strong className="text-foreground">Fine-grained overrides</strong> — these
                        target specific elements inside the broad zones above. CSS specificity wins,
                        so e.g. setting <em>Product name</em> font size overrides the broader{' '}
                        <em>Products</em> setting for product names only.
                      </div>
                    )}
                    <div className="rounded-xl border border-border/60 bg-background p-4">
                      <div className="flex items-center justify-between">
                        <h3 className="text-sm font-semibold text-foreground">
                          {isAr ? z.labelAr : z.label}
                        </h3>
                        {z.isSubZone && (
                          <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
                            sub-zone
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground">{z.description}</p>
                      <div className="mt-3 grid gap-3 md:grid-cols-3">
                        <label className="flex flex-col gap-1">
                          <span className="text-xs font-medium text-muted-foreground">
                            Font family
                          </span>
                          <select
                            value={cfg.fontFamily ?? ''}
                            onChange={e => updateZone(z.key, { fontFamily: e.target.value })}
                            className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
                          >
                            {familyOptions.map(o => (
                              <option key={o.value} value={o.value}>
                                {o.label}
                              </option>
                            ))}
                          </select>
                          <span className="text-[11px] text-muted-foreground/80">
                            Inherits the template default if left blank.
                          </span>
                        </label>
                        <label className="flex flex-col gap-1">
                          <span className="text-xs font-medium text-muted-foreground">
                            Font size
                          </span>
                          <input
                            type="text"
                            value={cfg.fontSize ?? ''}
                            onChange={e => updateZone(z.key, { fontSize: e.target.value })}
                            placeholder={`e.g. 16 or 16px or 1rem`}
                            className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
                          />
                          <span className="text-[11px] text-muted-foreground/80">
                            Template default ≈ {z.defaults.fontSize}. A bare number is treated as
                            pixels (16 → 16px).
                          </span>
                        </label>
                        <label className="flex flex-col gap-1">
                          <span className="text-xs font-medium text-muted-foreground">
                            Font weight
                          </span>
                          <input
                            type="text"
                            value={cfg.fontWeight ?? ''}
                            onChange={e => updateZone(z.key, { fontWeight: e.target.value })}
                            placeholder={`inherit (≈ ${z.defaults.fontWeight})`}
                            className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
                          />
                          <span className="text-[11px] text-muted-foreground/80">
                            Template default ≈ {z.defaults.fontWeight}.
                          </span>
                        </label>
                        <label className="flex flex-col gap-1">
                          <span className="text-xs font-medium text-muted-foreground">Color</span>
                          <div className="flex gap-2">
                            <input
                              type="color"
                              value={
                                cfg.color && /^#[0-9a-f]{6}$/i.test(cfg.color)
                                  ? cfg.color
                                  : '#000000'
                              }
                              onChange={e => updateZone(z.key, { color: e.target.value })}
                              className="h-10 w-12 cursor-pointer rounded-lg border border-border bg-background"
                              aria-label="Pick color"
                            />
                            <input
                              type="text"
                              value={cfg.color ?? ''}
                              onChange={e => updateZone(z.key, { color: e.target.value })}
                              placeholder="#000000 / hsl(...) / rgb(...)"
                              className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm"
                            />
                          </div>
                          <span className="text-[11px] text-muted-foreground/80">
                            Template default = the active theme's foreground color.
                          </span>
                        </label>
                        <label className="flex flex-col gap-1">
                          <span className="text-xs font-medium text-muted-foreground">
                            Line height
                          </span>
                          <input
                            type="text"
                            value={cfg.lineHeight ?? ''}
                            onChange={e => updateZone(z.key, { lineHeight: e.target.value })}
                            placeholder="auto (1.6)"
                            className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
                          />
                          <span className="text-[11px] text-muted-foreground/80">
                            Leave blank for automatic — we apply <strong>1.6</strong> whenever you
                            set a font-size, which keeps Arabic characters from getting their tops
                            clipped. Template default ≈ {z.defaults.lineHeight}.
                          </span>
                        </label>
                        <label className="flex flex-col gap-1">
                          <span className="text-xs font-medium text-muted-foreground">
                            Letter spacing
                          </span>
                          <input
                            type="text"
                            value={cfg.letterSpacing ?? ''}
                            onChange={e => updateZone(z.key, { letterSpacing: e.target.value })}
                            placeholder="inherit (≈ normal)"
                            className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
                          />
                          <span className="text-[11px] text-muted-foreground/80">
                            Template default ≈ normal (0).
                          </span>
                        </label>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        </div>
      )}
    </AdminLayout>
  );
}
