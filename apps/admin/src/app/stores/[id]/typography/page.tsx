'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { useLocale } from 'next-intl';
import Link from 'next/link';
import { Button, useToast } from '@force/ui';
import { AdminLayout } from '../../../../components/AdminLayout';
import { useCurrentStore } from '../../../../hooks/useCurrentStore';
import { apiGet, apiPut, apiFetch } from '../../../../lib/api';

// Typography is store-scoped and template-agnostic — the storefront's
// data-zone wrappers in ShopChrome (and the in-template grid wrappers)
// catch the same six zones regardless of which pack the merchant has
// active. Keep this UI in lock-step with the Zod schema in
// apps/api/src/routes/typography.routes.ts.

// Per-zone metadata. Sizes / weights aren't fixed numbers — they
// vary across the 5 packs (Modern / Classic / Minimal / Bold /
// Elegant) and even across elements inside a single zone (a section
// H2 is bigger than a category-tile label even though both live
// inside the "categories" zone). Leaving a zone field blank inherits
// from the active template's CSS for that specific element. Don't
// invent and display fake "Template default ≈ Npx" hints — they
// were misleading.
interface ZoneDef {
  key: ZoneKey;
  label: string;
  labelAr: string;
  description: string;
  descriptionAr: string;
  /** Marks the row visually as a sub-zone (rendered as a nested
   *  override of one of the broad zones). */
  isSubZone?: boolean;
}

const ZONES: ZoneDef[] = [
  // Broad zones — wrap whole storefront regions. Descriptions point at
  // concrete UI elements + give an example of what changes when the
  // merchant tweaks this zone, so they know exactly which part of the
  // store they're editing.
  {
    key: 'beforeHeader',
    label: 'Announcement bar (top promo strip)',
    labelAr: 'شريط الإعلان (أعلى الصفحة)',
    description:
      'The narrow promo banner at the very top of every page — typically "Free shipping over 30 KWD" or a discount code.',
    descriptionAr:
      'الشريط الترويجي الضيق في أعلى كل صفحة — عادةً مثل "شحن مجاني فوق 30 د.ك" أو كود خصم.',
  },
  {
    key: 'header',
    label: 'Page header (logo + nav + cart icons)',
    labelAr: 'هيدر الصفحة (الشعار + القائمة + أيقونات السلة)',
    description:
      'Affects the store logo wordmark, the top navigation links ("Shop", "About", "Contact"), and any text next to the cart / search / account icons.',
    descriptionAr:
      'يؤثر على نص شعار المتجر، روابط القائمة العلوية (مثل "تسوّق"، "من نحن"، "تواصل")، والنصوص بجانب أيقونات السلة / البحث / الحساب.',
  },
  {
    key: 'categories',
    label: 'Categories section (homepage "Shop by Category")',
    labelAr: 'قسم الفئات (في الصفحة الرئيسية: "تسوّق حسب الفئة")',
    description:
      'The "Shop by Category" block on the homepage — the row of category tiles + their captions ("Sweets", "Drinks", etc.).',
    descriptionAr:
      'كتلة "تسوّق حسب الفئة" في الصفحة الرئيسية — صف بطاقات الفئات وأسماؤها (مثلاً "حلويات"، "مشروبات").',
  },
  {
    key: 'products',
    label: 'Products (listing, detail, carousels everywhere)',
    labelAr: 'المنتجات (في صفحة القائمة، صفحة المنتج، وكل الكاروسيلات)',
    description:
      'The base font for every product surface: /products listing, single-product detail page, "New Arrivals" + "Best Sellers" carousels on the homepage, cart-recommendation cards. Sub-zones below override this for product name + price specifically.',
    descriptionAr:
      'الخط الأساسي لكل صفحات المنتجات: قائمة /products، صفحة المنتج الواحد، كاروسيلات "أحدث المنتجات" و"الأكثر مبيعاً" في الصفحة الرئيسية، وبطاقات اقتراحات السلة. الأقسام الفرعية أدناه تتجاوز هذا للاسم والسعر فقط.',
  },
  {
    key: 'footer',
    label: 'Footer (bottom links + copyright)',
    labelAr: 'الفوتر (الروابط السفلية + حقوق النشر)',
    description:
      'The footer columns at the bottom of every page — "Shop", "Help", "About", social icons, and the copyright row.',
    descriptionAr:
      'أعمدة الفوتر في أسفل كل صفحة — "تسوّق"، "مساعدة"، "من نحن"، أيقونات السوشيال، وسطر حقوق النشر.',
  },
  {
    key: 'afterFooter',
    label: 'Below footer (cookie consent, etc.)',
    labelAr: 'تحت الفوتر (شريط الكوكيز ونحوه)',
    description:
      'Tiny elements that render below the footer — cookie consent banner, "Powered by Force" credit row.',
    descriptionAr: 'العناصر الصغيرة أسفل الفوتر — شريط موافقة الكوكيز، سطر "مدعوم من Force".',
  },
  // Sub-zones — nested overrides.
  // Section heading sub-zones split SectionHeading into 4 individually
  // styleable parts — so a coloured-pill style on the title doesn't
  // bleed onto the "View All" link next to it (Ahmad 2026-05-16).
  {
    key: 'sectionKicker',
    label: 'Section kicker (small chip above title)',
    labelAr: 'الشارة العلوية للقسم (الكبسولة الصغيرة فوق العنوان)',
    description:
      'The small uppercase chip rendered ABOVE each section title — e.g. "EXPLORE" above "Shop by Category", or "DISCOVER" above "Best Sellers". Style independently of the title.',
    descriptionAr:
      'الكبسولة الصغيرة فوق عنوان كل قسم — مثل "استكشف" فوق "تسوّق حسب الفئة"، أو "اكتشف" فوق "الأكثر مبيعاً". يمكن تنسيقها باستقلال عن العنوان.',
    isSubZone: true,
  },
  {
    key: 'sectionTitle',
    label: 'Section title ("Latest Products" / "أحدث المنتجات")',
    labelAr: 'عنوان القسم ("أحدث المنتجات" / "Latest Products")',
    description:
      'The big H2 headline on every homepage section — "Shop by Category", "Latest Products", "Best Sellers" — plus the H1 at the top of the products listing page.',
    descriptionAr:
      'العنوان الكبير (H2) في كل قسم بالصفحة الرئيسية — "تسوّق حسب الفئة"، "أحدث المنتجات"، "الأكثر مبيعاً" — بالإضافة إلى عنوان H1 في أعلى صفحة قائمة المنتجات.',
    isSubZone: true,
  },
  {
    key: 'sectionSubtitle',
    label: 'Section subtitle (tagline under title)',
    labelAr: 'العنوان الفرعي للقسم (النص الوصفي تحت العنوان)',
    description:
      'The descriptive tagline rendered BELOW each section title — e.g. "Browse our top picks by category" under "Shop by Category".',
    descriptionAr:
      'النص الوصفي الذي يظهر تحت عنوان القسم — مثل "تصفّح أفضل اختياراتنا حسب الفئة" تحت "تسوّق حسب الفئة".',
    isSubZone: true,
  },
  {
    key: 'sectionSeeAll',
    label: 'Section "View All" link',
    labelAr: 'رابط "عرض الكل" في القسم',
    description:
      'The "View All" / "عرض الكل" link in the top-right of each homepage section — next to "Latest Products", "Best Sellers", "Shop by Category". Click jumps to the full listing.',
    descriptionAr:
      'رابط "عرض الكل" أعلى يسار كل قسم في الصفحة الرئيسية — بجانب "أحدث المنتجات"، "الأكثر مبيعاً"، "تسوّق حسب الفئة". ينقل المستخدم إلى القائمة الكاملة.',
    isSubZone: true,
  },
  {
    key: 'productName',
    label: 'Product name (on product cards)',
    labelAr: 'اسم المنتج (على بطاقة المنتج)',
    description:
      'The product title text on every product card — homepage carousels, /products grid, search results, cart recommendations. Overrides the broader "Products" font when you want the name styled differently from the price.',
    descriptionAr:
      'اسم المنتج على كل بطاقة منتج — كاروسيلات الصفحة الرئيسية، شبكة /products، نتائج البحث، اقتراحات السلة. يتجاوز خط "المنتجات" العام عندما تريد تنسيق الاسم بشكل مختلف عن السعر.',
    isSubZone: true,
  },
  {
    key: 'productPrice',
    label: 'Product price (on product cards)',
    labelAr: 'سعر المنتج (على بطاقة المنتج)',
    description:
      'The price text on every product card — e.g. "12.500 KWD". Affects all cards: homepage carousels, listing page, search results, cart recommendations.',
    descriptionAr:
      'نص السعر على كل بطاقة منتج — مثلاً "12.500 د.ك". يؤثر على كل البطاقات: كاروسيلات الصفحة الرئيسية، صفحة القائمة، نتائج البحث، اقتراحات السلة.',
    isSubZone: true,
  },
  {
    key: 'cta',
    label: 'Buttons + CTAs (Add to cart, Subscribe, etc.)',
    labelAr: 'الأزرار والدعوات للفعل (أضف للسلة، اشترك، ...)',
    description:
      'Every action button on the storefront — "Add to cart" on product cards, "Subscribe" in newsletter, "Place order" at checkout, "View store" everywhere.',
    descriptionAr:
      'كل أزرار الفعل في المتجر — "أضف للسلة" على بطاقات المنتج، "اشترك" في النشرة، "أكمل الطلب" في الدفع، "عرض المتجر" في كل مكان.',
    isSubZone: true,
  },
  {
    key: 'filters',
    label: 'Filter sidebar (on /products page)',
    labelAr: 'الشريط الجانبي للفلاتر (في صفحة /products)',
    description:
      'The left sidebar on /products — sort dropdown, search field, price range slider, category chips, in-stock toggle.',
    descriptionAr:
      'الشريط الجانبي الأيسر في /products — قائمة الترتيب، حقل البحث، شريط نطاق السعر، رقاقات الفئات، مفتاح "متوفر فقط".',
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
  | 'sectionKicker'
  | 'sectionTitle'
  | 'sectionSubtitle'
  | 'sectionSeeAll'
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
  // Colored-label / chip styling. backgroundColor accepts brand presets
  // (`brand-primary`, `brand-secondary`, etc.) which the storefront
  // resolves to the store's theme CSS variables.
  backgroundColor?: string;
  padding?: string;
  borderRadius?: string;
  // Text decoration — underline / line-through, plus optional colour +
  // thickness + offset.
  textDecoration?: string;
  textDecorationColor?: string;
  textDecorationThickness?: string;
  textUnderlineOffset?: string;
}

// Brand-color preset tokens. The storefront translates these to
// hsl(var(--primary)) etc. so the typography stays linked to the
// store's brand palette — merchant doesn't have to copy hex values.
const BRAND_COLOR_PRESETS: Array<{ value: string; label: string; labelAr: string }> = [
  { value: 'brand-primary', label: 'Brand primary', labelAr: 'لون العلامة الرئيسي' },
  { value: 'brand-secondary', label: 'Brand secondary', labelAr: 'لون العلامة الثانوي' },
  { value: 'brand-accent', label: 'Brand accent', labelAr: 'لون التمييز' },
  { value: 'brand-foreground', label: 'Brand foreground (text)', labelAr: 'لون النص الأساسي' },
  { value: 'brand-muted', label: 'Brand muted', labelAr: 'لون مخفف' },
];

// Quick-apply chip presets — fill backgroundColor + padding + borderRadius
// in one click so merchants don't have to figure out the right padding
// or radius numbers themselves.
const CHIP_STYLE_PRESETS: Array<{
  id: string;
  label: string;
  labelAr: string;
  values: Pick<ZoneSettings, 'backgroundColor' | 'padding' | 'borderRadius' | 'color'>;
}> = [
  {
    id: 'pill-primary',
    label: 'Pill — Brand primary',
    labelAr: 'كبسولة — لون رئيسي',
    values: {
      backgroundColor: 'brand-primary',
      padding: '4px 14px',
      borderRadius: '9999px',
      color: '#ffffff',
    },
  },
  {
    id: 'chip-primary-soft',
    label: 'Soft chip — Brand primary tint',
    labelAr: 'شارة ناعمة — لون رئيسي مخفف',
    values: {
      backgroundColor: 'brand-primary',
      padding: '4px 12px',
      borderRadius: '8px',
      color: '#ffffff',
    },
  },
  {
    id: 'pill-secondary',
    label: 'Pill — Brand secondary',
    labelAr: 'كبسولة — لون ثانوي',
    values: {
      backgroundColor: 'brand-secondary',
      padding: '4px 14px',
      borderRadius: '9999px',
      color: '#ffffff',
    },
  },
];

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

  // Real measured per-zone defaults from the live storefront. We
  // load the storefront homepage in a hidden iframe with
  // `?probe=typography`, the storefront's TypographyProbe component
  // measures `getComputedStyle()` for the first element of each
  // data-zone after hydration, and posts the values back here. This
  // replaces the fake "Template default ≈ 24px" hints I had to
  // delete — now the merchant sees the actual inherited number for
  // their currently-active template + any overrides they already saved.
  const [measured, setMeasured] = useState<Record<string, Record<string, string>> | null>(null);
  const { store: currentStore } = useCurrentStore(storeId);
  const probeUrl = useMemo(() => {
    const domain = currentStore?.domain;
    const slug = currentStore?.slug;
    const base = domain
      ? `https://${domain}`
      : process.env.NEXT_PUBLIC_WEB_URL && slug
        ? `${process.env.NEXT_PUBLIC_WEB_URL}/${slug}`
        : null;
    return base ? `${base}?probe=typography` : null;
  }, [currentStore?.domain, currentStore?.slug]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = (e: MessageEvent) => {
      if (!e.data || e.data.type !== 'force:typography-probe') return;
      const m = e.data.measurements;
      if (m && typeof m === 'object') setMeasured(m);
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  /**
   * Format a getComputedStyle value into something readable. The
   * browser returns canonical values: `font-size: '14.4px'`,
   * `line-height: 'normal'` or `'24px'`, `font-weight: '500'`,
   * `color: 'rgb(0, 0, 0)'`. Display them roughly as-is — the
   * merchant cares about the units, not pretty formatting.
   */
  const fmt = (v?: string) => {
    if (!v) return '—';
    if (v === 'normal') return 'normal';
    return v;
  };

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
  //
  // CRITICAL: preserve ALL existing zones from `typo.zones` even if a
  // key isn't in the ZONES array (legacy keys, future-additions, etc.).
  // The earlier implementation rebuilt `applied` from ZONES only, which
  // wiped any zone not listed there — losing chip / underline settings
  // when the merchant clicked "Apply to all zones" on a font.
  const applyFontToAllZones = (family: string) => {
    const applied: Typography['zones'] = {};
    const allKeys = new Set<ZoneKey>([
      ...ZONES.map(z => z.key),
      ...(Object.keys(typo.zones) as ZoneKey[]),
    ]);
    for (const key of allKeys) {
      const existing = typo.zones[key] ?? {};
      applied[key] = { ...existing, fontFamily: family };
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
                      <p className="mt-1 text-sm text-muted-foreground leading-relaxed">
                        {isAr ? z.descriptionAr : z.description}
                      </p>
                      <div className="mt-3 grid gap-3 md:grid-cols-3">
                        <label className="flex flex-col gap-1">
                          <span className="text-sm font-medium text-muted-foreground">
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
                          <span className="text-xs text-muted-foreground/80">
                            {measured?.[z.key]?.fontFamily ? (
                              <>
                                Currently inherits{' '}
                                <strong>{fmt(measured[z.key].fontFamily)}</strong>.
                              </>
                            ) : (
                              'Inherits the template default if left blank.'
                            )}
                          </span>
                        </label>
                        <label className="flex flex-col gap-1">
                          <span className="text-sm font-medium text-muted-foreground">
                            Font size
                          </span>
                          <input
                            type="text"
                            value={cfg.fontSize ?? ''}
                            onChange={e => updateZone(z.key, { fontSize: e.target.value })}
                            placeholder="e.g. 16 or 16px or 1rem"
                            className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
                          />
                          <span className="text-xs text-muted-foreground/80">
                            {measured?.[z.key]?.fontSize ? (
                              <>
                                Currently inherits <strong>{fmt(measured[z.key].fontSize)}</strong>{' '}
                                on your live storefront.
                              </>
                            ) : (
                              'Leave blank to inherit from your active template.'
                            )}{' '}
                            A bare number is treated as pixels (16 → 16px).
                          </span>
                        </label>
                        <label className="flex flex-col gap-1">
                          <span className="text-sm font-medium text-muted-foreground">
                            Font weight
                          </span>
                          <input
                            type="text"
                            value={cfg.fontWeight ?? ''}
                            onChange={e => updateZone(z.key, { fontWeight: e.target.value })}
                            placeholder="inherit"
                            className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
                          />
                          <span className="text-xs text-muted-foreground/80">
                            {measured?.[z.key]?.fontWeight ? (
                              <>
                                Currently inherits{' '}
                                <strong>{fmt(measured[z.key].fontWeight)}</strong>.
                              </>
                            ) : (
                              'Leave blank to inherit.'
                            )}{' '}
                            Use 400 for regular, 600 for semibold, 700 for bold.
                          </span>
                        </label>
                        <label className="flex flex-col gap-1">
                          <span className="text-sm font-medium text-muted-foreground">
                            {isAr ? 'لون النص' : 'Text colour'}
                          </span>
                          {/* Two-row layout matches the colored-label
                              backgroundColor field below — picker + brand
                              preset on row 1, full-width text input on
                              row 2. Single-row layout cramped the text
                              input inside a 3-col parent grid. */}
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
                              aria-label={isAr ? 'اختر اللون' : 'Pick color'}
                            />
                            <select
                              value={
                                BRAND_COLOR_PRESETS.some(p => p.value === cfg.color)
                                  ? cfg.color
                                  : ''
                              }
                              onChange={e =>
                                e.target.value
                                  ? updateZone(z.key, { color: e.target.value })
                                  : undefined
                              }
                              className="flex-1 rounded-lg border border-border bg-background px-2 py-2 text-xs"
                              aria-label={isAr ? 'لون العلامة التجارية' : 'Brand color preset'}
                            >
                              <option value="">
                                {isAr ? '— اختر من ألوان العلامة —' : '— or pick brand preset —'}
                              </option>
                              {BRAND_COLOR_PRESETS.map(p => (
                                <option key={p.value} value={p.value}>
                                  {isAr ? p.labelAr : p.label}
                                </option>
                              ))}
                            </select>
                          </div>
                          <input
                            type="text"
                            value={cfg.color ?? ''}
                            onChange={e => updateZone(z.key, { color: e.target.value })}
                            placeholder="#000000 / brand-primary / hsl(...)"
                            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                          />
                          <span className="text-xs text-muted-foreground/80">
                            {measured?.[z.key]?.color ? (
                              <>
                                Currently inherits <strong>{fmt(measured[z.key].color)}</strong>.
                              </>
                            ) : (
                              "Inherits from the active theme's foreground colour."
                            )}
                          </span>
                        </label>
                        <label className="flex flex-col gap-1">
                          <span className="text-sm font-medium text-muted-foreground">
                            Line height
                          </span>
                          <input
                            type="text"
                            value={cfg.lineHeight ?? ''}
                            onChange={e => updateZone(z.key, { lineHeight: e.target.value })}
                            placeholder="auto (1.6)"
                            className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
                          />
                          <span className="text-xs text-muted-foreground/80">
                            {measured?.[z.key]?.lineHeight ? (
                              <>
                                Currently inherits{' '}
                                <strong>{fmt(measured[z.key].lineHeight)}</strong>.{' '}
                              </>
                            ) : null}
                            Leave blank for automatic — we apply <strong>1.6</strong> whenever you
                            set a font-size so Arabic characters don't get their tops clipped.
                          </span>
                        </label>
                        <label className="flex flex-col gap-1">
                          <span className="text-sm font-medium text-muted-foreground">
                            Letter spacing
                          </span>
                          <input
                            type="text"
                            value={cfg.letterSpacing ?? ''}
                            onChange={e => updateZone(z.key, { letterSpacing: e.target.value })}
                            placeholder="inherit"
                            className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
                          />
                          <span className="text-xs text-muted-foreground/80">
                            {measured?.[z.key]?.letterSpacing ? (
                              <>
                                Currently inherits{' '}
                                <strong>{fmt(measured[z.key].letterSpacing)}</strong>.
                              </>
                            ) : (
                              'Leave blank to inherit (typically `normal`).'
                            )}
                          </span>
                        </label>
                      </div>

                      {/* Colored label / chip styling — backgroundColor +
                          padding + borderRadius. Quick-apply preset
                          buttons fill all three at once so merchants
                          don't have to figure out the right radius. */}
                      <div className="mt-4 rounded-lg border border-dashed border-border/60 p-3">
                        <div className="flex items-center justify-between">
                          <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                            {isAr ? 'شارة ملونة' : 'Colored label'}
                          </h4>
                          {(cfg.backgroundColor || cfg.padding || cfg.borderRadius) && (
                            <button
                              type="button"
                              onClick={() =>
                                updateZone(z.key, {
                                  backgroundColor: '',
                                  padding: '',
                                  borderRadius: '',
                                })
                              }
                              className="text-[11px] text-destructive hover:underline"
                            >
                              {isAr ? 'مسح' : 'Clear'}
                            </button>
                          )}
                        </div>
                        <p className="mt-0.5 text-[11px] text-muted-foreground">
                          {isAr
                            ? 'حوّل العنوان إلى شارة ملونة مع خلفية + هوامش داخلية + زوايا مستديرة. اختر إعدادًا جاهزًا أو خصصه يدويًا.'
                            : 'Turn the heading into a coloured chip with background + padding + rounded corners. Pick a preset or customise the fields below.'}
                        </p>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {CHIP_STYLE_PRESETS.map(p => (
                            <button
                              key={p.id}
                              type="button"
                              onClick={() => updateZone(z.key, p.values)}
                              className="rounded-full border border-border bg-background px-3 py-1 text-[11px] font-medium text-foreground hover:bg-muted"
                            >
                              {isAr ? p.labelAr : p.label}
                            </button>
                          ))}
                        </div>
                        <div className="mt-3 grid gap-3 md:grid-cols-3">
                          <label className="flex flex-col gap-1">
                            <span className="text-xs font-medium text-muted-foreground">
                              {isAr ? 'لون الخلفية' : 'Background colour'}
                            </span>
                            <div className="flex gap-2">
                              <input
                                type="color"
                                value={
                                  cfg.backgroundColor && /^#[0-9a-f]{6}$/i.test(cfg.backgroundColor)
                                    ? cfg.backgroundColor
                                    : '#FF7700'
                                }
                                onChange={e =>
                                  updateZone(z.key, { backgroundColor: e.target.value })
                                }
                                className="h-9 w-10 cursor-pointer rounded-lg border border-border bg-background"
                                aria-label="Pick background color"
                              />
                              <select
                                value={
                                  BRAND_COLOR_PRESETS.some(p => p.value === cfg.backgroundColor)
                                    ? cfg.backgroundColor
                                    : ''
                                }
                                onChange={e =>
                                  e.target.value
                                    ? updateZone(z.key, { backgroundColor: e.target.value })
                                    : undefined
                                }
                                className="flex-1 rounded-lg border border-border bg-background px-2 py-1.5 text-xs"
                              >
                                <option value="">— or pick brand preset —</option>
                                {BRAND_COLOR_PRESETS.map(p => (
                                  <option key={p.value} value={p.value}>
                                    {isAr ? p.labelAr : p.label}
                                  </option>
                                ))}
                              </select>
                            </div>
                            <input
                              type="text"
                              value={cfg.backgroundColor ?? ''}
                              onChange={e => updateZone(z.key, { backgroundColor: e.target.value })}
                              placeholder="#FF7700 / brand-primary"
                              className="rounded-lg border border-border bg-background px-3 py-1.5 text-xs"
                            />
                          </label>
                          <label className="flex flex-col gap-1">
                            <span className="text-xs font-medium text-muted-foreground">
                              {isAr ? 'الهوامش الداخلية' : 'Padding'}
                            </span>
                            <input
                              type="text"
                              value={cfg.padding ?? ''}
                              onChange={e => updateZone(z.key, { padding: e.target.value })}
                              placeholder="4px 12px"
                              className="rounded-lg border border-border bg-background px-3 py-1.5 text-xs"
                            />
                            <span className="text-xs text-muted-foreground/80">
                              {isAr
                                ? 'الترتيب: علوي يمين سفلي يسار. مثال: "4px 12px"'
                                : 'Top-right-bottom-left. e.g. "4px 12px" or "0.25rem 0.75rem".'}
                            </span>
                          </label>
                          <label className="flex flex-col gap-1">
                            <span className="text-xs font-medium text-muted-foreground">
                              {isAr ? 'استدارة الزوايا' : 'Corner radius'}
                            </span>
                            <input
                              type="text"
                              value={cfg.borderRadius ?? ''}
                              onChange={e => updateZone(z.key, { borderRadius: e.target.value })}
                              placeholder="9999px (pill) / 8px (chip)"
                              className="rounded-lg border border-border bg-background px-3 py-1.5 text-xs"
                            />
                            <span className="text-xs text-muted-foreground/80">
                              {isAr
                                ? '"9999px" لشكل كبسولة، "8px" لشارة، "0" لزوايا حادة.'
                                : '"9999px" pill, "8px" rounded chip, "0" sharp corners.'}
                            </span>
                          </label>
                        </div>
                      </div>

                      {/* Text decoration — underline + line-through.
                          Underline is the common case so we surface it as
                          a toggle; advanced controls (colour, thickness,
                          offset) live below for fine tuning. */}
                      <div className="mt-3 rounded-lg border border-dashed border-border/60 p-3">
                        <div className="flex items-center justify-between">
                          <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                            {isAr ? 'الزخرفة (تسطير)' : 'Text decoration'}
                          </h4>
                          {(cfg.textDecoration ||
                            cfg.textDecorationColor ||
                            cfg.textDecorationThickness ||
                            cfg.textUnderlineOffset) && (
                            <button
                              type="button"
                              onClick={() =>
                                updateZone(z.key, {
                                  textDecoration: '',
                                  textDecorationColor: '',
                                  textDecorationThickness: '',
                                  textUnderlineOffset: '',
                                })
                              }
                              className="text-[11px] text-destructive hover:underline"
                            >
                              {isAr ? 'مسح' : 'Clear'}
                            </button>
                          )}
                        </div>
                        <div className="mt-2 flex flex-wrap gap-2">
                          <label className="flex items-center gap-2 text-xs">
                            <input
                              type="radio"
                              name={`decoration-${z.key}`}
                              checked={!cfg.textDecoration || cfg.textDecoration === 'none'}
                              onChange={() =>
                                updateZone(z.key, { textDecoration: '', textDecorationColor: '' })
                              }
                            />
                            {isAr ? 'بدون' : 'None'}
                          </label>
                          <label className="flex items-center gap-2 text-xs">
                            <input
                              type="radio"
                              name={`decoration-${z.key}`}
                              checked={cfg.textDecoration === 'underline'}
                              onChange={() => updateZone(z.key, { textDecoration: 'underline' })}
                            />
                            {isAr ? 'تسطير' : 'Underline'}
                          </label>
                          <label className="flex items-center gap-2 text-xs">
                            <input
                              type="radio"
                              name={`decoration-${z.key}`}
                              checked={cfg.textDecoration === 'line-through'}
                              onChange={() => updateZone(z.key, { textDecoration: 'line-through' })}
                            />
                            {isAr ? 'شطب' : 'Strike-through'}
                          </label>
                        </div>
                        {cfg.textDecoration && cfg.textDecoration !== 'none' && (
                          <div className="mt-3 grid gap-3 md:grid-cols-3">
                            <label className="flex flex-col gap-1">
                              <span className="text-xs font-medium text-muted-foreground">
                                {isAr ? 'لون الخط' : 'Line colour'}
                              </span>
                              <div className="flex gap-2">
                                <input
                                  type="color"
                                  value={
                                    cfg.textDecorationColor &&
                                    /^#[0-9a-f]{6}$/i.test(cfg.textDecorationColor)
                                      ? cfg.textDecorationColor
                                      : '#FF7700'
                                  }
                                  onChange={e =>
                                    updateZone(z.key, { textDecorationColor: e.target.value })
                                  }
                                  className="h-9 w-10 cursor-pointer rounded-lg border border-border bg-background"
                                  aria-label="Pick underline color"
                                />
                                <select
                                  value={
                                    BRAND_COLOR_PRESETS.some(
                                      p => p.value === cfg.textDecorationColor
                                    )
                                      ? cfg.textDecorationColor
                                      : ''
                                  }
                                  onChange={e =>
                                    e.target.value
                                      ? updateZone(z.key, { textDecorationColor: e.target.value })
                                      : undefined
                                  }
                                  className="flex-1 rounded-lg border border-border bg-background px-2 py-1.5 text-xs"
                                >
                                  <option value="">— brand preset —</option>
                                  {BRAND_COLOR_PRESETS.map(p => (
                                    <option key={p.value} value={p.value}>
                                      {isAr ? p.labelAr : p.label}
                                    </option>
                                  ))}
                                </select>
                              </div>
                            </label>
                            <label className="flex flex-col gap-1">
                              <span className="text-xs font-medium text-muted-foreground">
                                {isAr ? 'سماكة الخط' : 'Thickness'}
                              </span>
                              <input
                                type="text"
                                value={cfg.textDecorationThickness ?? ''}
                                onChange={e =>
                                  updateZone(z.key, { textDecorationThickness: e.target.value })
                                }
                                placeholder="auto / 1px / 0.1em"
                                className="rounded-lg border border-border bg-background px-3 py-1.5 text-xs"
                              />
                            </label>
                            <label className="flex flex-col gap-1">
                              <span className="text-xs font-medium text-muted-foreground">
                                {isAr ? 'المسافة من النص' : 'Offset from text'}
                              </span>
                              <input
                                type="text"
                                value={cfg.textUnderlineOffset ?? ''}
                                onChange={e =>
                                  updateZone(z.key, { textUnderlineOffset: e.target.value })
                                }
                                placeholder="auto / 2px / 0.15em"
                                className="rounded-lg border border-border bg-background px-3 py-1.5 text-xs"
                              />
                            </label>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        </div>
      )}

      {/* Hidden iframe loads the live storefront with `?probe=
          typography`. The storefront's TypographyProbe component
          measures real getComputedStyle values per data-zone after
          hydration and posts them back here via postMessage; the
          listener wired up in useEffect populates `measured`. We use
          opacity:0 + pointer-events:none + position:absolute rather
          than display:none so the iframe still lays out and
          stylesheets actually compute. */}
      {probeUrl && (
        <iframe
          src={probeUrl}
          aria-hidden
          tabIndex={-1}
          title="Typography defaults probe"
          // Off-screen rather than display:none so the iframe actually
          // renders the storefront, computes styles, and runs the
          // probe component. Desktop-ish viewport so layout-driven
          // rules (e.g. responsive font scales) match what shoppers see.
          style={{
            position: 'fixed',
            top: '-99999px',
            left: '-99999px',
            width: '1280px',
            height: '720px',
            border: 0,
            visibility: 'hidden',
          }}
        />
      )}
    </AdminLayout>
  );
}
