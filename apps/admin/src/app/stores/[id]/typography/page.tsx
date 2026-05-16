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
  /** Sample text shown in the live preview block so the merchant can
   *  see what the zone's text actually looks like with the current
   *  settings. Should mirror what the storefront actually renders in
   *  that zone (e.g. "Latest Products" for sectionTitle). Bilingual so
   *  Arabic merchants see Arabic preview when toggled. */
  previewText: string;
  previewTextAr: string;
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
    previewText: 'Free shipping on orders over 30 KWD — use code SAFFRON10',
    previewTextAr: 'شحن مجاني للطلبات فوق 30 د.ك — استخدم كود SAFFRON10',
  },
  {
    key: 'header',
    label: 'Page header (logo + nav + cart icons)',
    labelAr: 'هيدر الصفحة (الشعار + القائمة + أيقونات السلة)',
    description:
      'Affects the store logo wordmark, the top navigation links ("Shop", "About", "Contact"), and any text next to the cart / search / account icons.',
    descriptionAr:
      'يؤثر على نص شعار المتجر، روابط القائمة العلوية (مثل "تسوّق"، "من نحن"، "تواصل")، والنصوص بجانب أيقونات السلة / البحث / الحساب.',
    previewText: 'Wady Aljuz · Shop · About · Contact',
    previewTextAr: 'وادي الجوز · تسوّق · من نحن · تواصل',
  },
  {
    key: 'categories',
    label: 'Categories section (homepage "Shop by Category")',
    labelAr: 'قسم الفئات (في الصفحة الرئيسية: "تسوّق حسب الفئة")',
    description:
      'The "Shop by Category" block on the homepage — the row of category tiles + their captions ("Sweets", "Drinks", etc.).',
    descriptionAr:
      'كتلة "تسوّق حسب الفئة" في الصفحة الرئيسية — صف بطاقات الفئات وأسماؤها (مثلاً "حلويات"، "مشروبات").',
    previewText: 'Sweets · Drinks · Bakery · Spices',
    previewTextAr: 'حلويات · مشروبات · مخبوزات · بهارات',
  },
  {
    key: 'products',
    label: 'Products (listing, detail, carousels everywhere)',
    labelAr: 'المنتجات (في صفحة القائمة، صفحة المنتج، وكل الكاروسيلات)',
    description:
      'The base font for every product surface: /products listing, single-product detail page, "New Arrivals" + "Best Sellers" carousels on the homepage, cart-recommendation cards. Sub-zones below override this for product name + price specifically.',
    descriptionAr:
      'الخط الأساسي لكل صفحات المنتجات: قائمة /products، صفحة المنتج الواحد، كاروسيلات "أحدث المنتجات" و"الأكثر مبيعاً" في الصفحة الرئيسية، وبطاقات اقتراحات السلة. الأقسام الفرعية أدناه تتجاوز هذا للاسم والسعر فقط.',
    previewText: 'Premium Saffron Tea — 12.500 KWD — In stock',
    previewTextAr: 'شاي الزعفران الفاخر — 12.500 د.ك — متوفر',
  },
  {
    key: 'footer',
    label: 'Footer (bottom links + copyright)',
    labelAr: 'الفوتر (الروابط السفلية + حقوق النشر)',
    description:
      'The footer columns at the bottom of every page — "Shop", "Help", "About", social icons, and the copyright row.',
    descriptionAr:
      'أعمدة الفوتر في أسفل كل صفحة — "تسوّق"، "مساعدة"، "من نحن"، أيقونات السوشيال، وسطر حقوق النشر.',
    previewText: '© 2026 Wady Aljuz · Privacy · Terms · Contact',
    previewTextAr: '© 2026 وادي الجوز · الخصوصية · الشروط · تواصل معنا',
  },
  {
    key: 'afterFooter',
    label: 'Below footer (cookie consent, etc.)',
    labelAr: 'تحت الفوتر (شريط الكوكيز ونحوه)',
    description:
      'Tiny elements that render below the footer — cookie consent banner, "Powered by Force" credit row.',
    descriptionAr: 'العناصر الصغيرة أسفل الفوتر — شريط موافقة الكوكيز، سطر "مدعوم من Force".',
    previewText: 'Powered by Force',
    previewTextAr: 'مدعوم من فورس',
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
    previewText: 'EXPLORE',
    previewTextAr: 'استكشف',
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
    previewText: 'Latest Products',
    previewTextAr: 'أحدث المنتجات',
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
    previewText: 'Browse our top picks by category',
    previewTextAr: 'تصفّح أفضل اختياراتنا حسب الفئة',
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
    previewText: 'View All →',
    previewTextAr: '← عرض الكل',
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
    previewText: 'Premium Saffron Tea',
    previewTextAr: 'شاي الزعفران الفاخر',
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
    previewText: '12.500 KWD',
    previewTextAr: '12.500 د.ك',
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
    previewText: 'Add to Cart',
    previewTextAr: 'أضف للسلة',
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
    previewText: 'Sort by: Popular',
    previewTextAr: 'الترتيب: الأكثر شعبية',
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

// Convert HSL component string (e.g. "220 13% 18%") to hex (#rrggbb).
// Populates the native color picker swatch when a merchant selects a
// brand preset — without this the picker shows #000000 regardless of
// the actual brand colour. Returns null on parse failure.
function hslComponentsToHex(s: string | undefined | null): string | null {
  if (!s) return null;
  const m = /^([0-9.]+)\s+([0-9.]+)%\s+([0-9.]+)%/.exec(s.trim());
  if (!m) return null;
  const h = parseFloat(m[1]);
  const sat = parseFloat(m[2]) / 100;
  const l = parseFloat(m[3]) / 100;
  const c = (1 - Math.abs(2 * l - 1)) * sat;
  const xc = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m2 = l - c / 2;
  let r = 0,
    g = 0,
    b = 0;
  if (h < 60) {
    r = c;
    g = xc;
  } else if (h < 120) {
    r = xc;
    g = c;
  } else if (h < 180) {
    g = c;
    b = xc;
  } else if (h < 240) {
    g = xc;
    b = c;
  } else if (h < 300) {
    r = xc;
    b = c;
  } else {
    r = c;
    b = xc;
  }
  const to255 = (v: number) =>
    Math.round((v + m2) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${to255(r)}${to255(g)}${to255(b)}`;
}

// Translate a brand-preset token to the hex from the store's theme.
// Storefront emits CSS using `hsl(var(--primary))`; the admin's native
// color picker needs a literal hex to show a swatch. This bridges them
// so the merchant SEES the brand colour on the picker when they pick
// "Brand primary" from the dropdown.
function resolveBrandPresetToHex(
  token: string | undefined,
  theme: Record<string, unknown> | undefined
): string | null {
  if (!token || !theme) return null;
  const themeKeyMap: Record<string, string> = {
    'brand-primary': 'primaryColor',
    'brand-secondary': 'secondaryColor',
    'brand-accent': 'accentColor',
    'brand-foreground': 'foregroundColor',
    'brand-muted': 'mutedColor',
    'brand-background': 'backgroundColor',
  };
  const key = themeKeyMap[token];
  if (!key) return null;
  const val = theme[key];
  return typeof val === 'string' ? hslComponentsToHex(val) : null;
}

// Same color resolution as the storefront's resolveColorValue + the
// admin's resolveBrandPresetToHex — used by the live preview block to
// emit React inline styles that mirror what the storefront will render
// once the merchant saves. Brand presets resolve to actual hex from the
// store theme so the preview shows the store's brand colour, not a CSS
// var that won't compute inside an inline-style attribute.
function resolveColorForPreview(
  v: string | undefined,
  theme: Record<string, unknown> | undefined
): string | undefined {
  if (!v) return undefined;
  const hex = resolveBrandPresetToHex(v, theme);
  return hex ?? v;
}

// Build a React inline-style object from a zone's settings. Mirrors the
// storefront emitter logic so what the merchant SEES in the live preview
// matches what they GET on the storefront after saving — including the
// inline-block auto-emit when chip props are set.
function cfgToInlineStyle(
  cfg: ZoneSettings,
  theme: Record<string, unknown> | undefined
): React.CSSProperties {
  const s: React.CSSProperties = {};
  if (cfg.fontFamily) s.fontFamily = cfg.fontFamily;
  if (cfg.fontSize) s.fontSize = cfg.fontSize;
  if (cfg.fontWeight) s.fontWeight = cfg.fontWeight;
  if (cfg.color) s.color = resolveColorForPreview(cfg.color, theme);
  if (cfg.lineHeight) s.lineHeight = cfg.lineHeight;
  if (cfg.letterSpacing) s.letterSpacing = cfg.letterSpacing;
  if (cfg.backgroundColor) s.backgroundColor = resolveColorForPreview(cfg.backgroundColor, theme);
  if (cfg.padding) s.padding = cfg.padding;
  if (cfg.borderRadius) s.borderRadius = cfg.borderRadius;
  if (cfg.backgroundColor || cfg.padding || cfg.borderRadius) s.display = 'inline-block';
  if (cfg.textDecoration && cfg.textDecoration !== 'none')
    s.textDecoration = cfg.textDecoration as React.CSSProperties['textDecoration'];
  if (cfg.textDecorationColor)
    s.textDecorationColor = resolveColorForPreview(cfg.textDecorationColor, theme);
  if (cfg.textDecorationThickness) s.textDecorationThickness = cfg.textDecorationThickness;
  if (cfg.textUnderlineOffset) s.textUnderlineOffset = cfg.textUnderlineOffset;
  return s;
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

// Multi-zone heading-style presets — one click applies a coherent look
// across the 4 section-heading sub-zones (kicker + title + subtitle +
// seeAll). Best-of-both-worlds: merchant gets a polished default in 1
// click, can still tweak any single zone afterwards (per-zone settings
// keep working as before — the preset just seeds them).
//
// "Main parts" per Ahmad 2026-05-16: section heading sub-zones are the
// most-visible per-section text on every storefront page; styling all 4
// coherently is the difference between "looks designed" and "looks like
// a config form." Other zones (header, footer, products) stay
// individually-controlled — overriding everything at once for the whole
// store would be too coarse.
const HEADING_STYLE_PRESETS: Array<{
  id: string;
  label: string;
  labelAr: string;
  description: string;
  descriptionAr: string;
  zoneSettings: Partial<Record<ZoneKey, ZoneSettings>>;
}> = [
  {
    id: 'brand-pill-heading',
    label: 'Brand pill heading',
    labelAr: 'عنوان بشارة العلامة',
    description: 'Primary-colour pill on kicker, bold dark title, muted subtitle, accent seeAll.',
    descriptionAr: 'كبسولة بلون العلامة الرئيسي للشارة، عنوان جريء داكن، نص فرعي مخفف.',
    zoneSettings: {
      sectionKicker: {
        backgroundColor: 'brand-primary',
        color: '#ffffff',
        padding: '4px 14px',
        borderRadius: '9999px',
        fontWeight: '600',
        letterSpacing: '0.1em',
      },
      sectionTitle: {
        fontWeight: '700',
        color: 'brand-foreground',
      },
      sectionSubtitle: {
        color: 'brand-muted',
      },
      sectionSeeAll: {
        color: 'brand-primary',
        textDecoration: 'underline',
        textDecorationColor: 'brand-primary',
        textUnderlineOffset: '4px',
      },
    },
  },
  {
    id: 'editorial-elegant',
    label: 'Editorial elegant',
    labelAr: 'تحريري أنيق',
    description: 'Tiny tracking-wide kicker, light large title, italic subtitle. Luxury feel.',
    descriptionAr: 'شارة دقيقة بتباعد واسع، عنوان كبير خفيف، نص فرعي مائل. شعور فاخر.',
    zoneSettings: {
      sectionKicker: {
        backgroundColor: '',
        // brand-foreground (dark text) — was brand-muted which is so
        // light it disappears on a white-ish bg. Editorial's quiet
        // feel comes from the wide tracking + light weight, not from
        // the color. Keep the color readable.
        color: 'brand-foreground',
        padding: '',
        borderRadius: '',
        fontWeight: '400',
        letterSpacing: '0.32em',
      },
      sectionTitle: {
        fontWeight: '300',
        letterSpacing: '-0.01em',
        color: 'brand-foreground',
      },
      sectionSubtitle: {
        color: 'brand-muted',
        fontWeight: '300',
      },
      sectionSeeAll: {
        color: 'brand-foreground',
        textDecoration: '',
        letterSpacing: '0.22em',
        fontWeight: '500',
      },
    },
  },
  {
    id: 'bold-uppercase',
    label: 'Bold uppercase',
    labelAr: 'جريء بأحرف كبيرة',
    description: 'Brand-foreground chip + black uppercase title, tight subtitle. Strong, modern.',
    descriptionAr: 'شارة بلون النص الأساسي + عنوان أسود بأحرف كبيرة. قوي وعصري.',
    zoneSettings: {
      sectionKicker: {
        backgroundColor: 'brand-foreground',
        color: 'brand-background',
        padding: '3px 10px',
        borderRadius: '4px',
        fontWeight: '900',
        letterSpacing: '0.08em',
      },
      sectionTitle: {
        fontWeight: '900',
        letterSpacing: '-0.01em',
        color: 'brand-foreground',
      },
      sectionSubtitle: {
        color: 'brand-muted',
        fontWeight: '500',
      },
      sectionSeeAll: {
        color: 'brand-foreground',
        textDecoration: '',
        fontWeight: '700',
        letterSpacing: '0.18em',
      },
    },
  },
  {
    id: 'soft-pastel',
    label: 'Soft pastel',
    labelAr: 'باستيل ناعم',
    description: 'Tinted-muted chip, medium title, no underline. Calm, friendly.',
    descriptionAr: 'شارة بلون مخفف، عنوان متوسط، بدون تسطير. هادئ وودود.',
    zoneSettings: {
      sectionKicker: {
        backgroundColor: 'brand-muted',
        color: 'brand-foreground',
        padding: '4px 12px',
        borderRadius: '6px',
        fontWeight: '600',
        letterSpacing: '0.08em',
      },
      sectionTitle: {
        fontWeight: '600',
        color: 'brand-foreground',
      },
      sectionSubtitle: {
        color: 'brand-muted',
      },
      sectionSeeAll: {
        color: 'brand-primary',
        textDecoration: 'underline',
        textUnderlineOffset: '3px',
      },
    },
  },
];

// Which zones the multi-zone preset buttons touch + reset together.
// "Main parts" of the section heading per Ahmad 2026-05-16.
const HEADING_PRESET_ZONES: ZoneKey[] = [
  'sectionKicker',
  'sectionTitle',
  'sectionSubtitle',
  'sectionSeeAll',
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

  // Apply a multi-zone heading-style preset across kicker + title +
  // subtitle + seeAll in one shot. Merges the preset's zoneSettings
  // into each target zone (preserves any unrelated fields like
  // fontFamily that the merchant set earlier) — so picking a preset
  // never wipes a font choice. Merchant can still tweak any single
  // zone afterwards.
  const applyHeadingPreset = (presetId: string) => {
    const preset = HEADING_STYLE_PRESETS.find(p => p.id === presetId);
    if (!preset) return;
    const nextZones = { ...typo.zones };
    for (const [zoneKey, settings] of Object.entries(preset.zoneSettings) as [
      ZoneKey,
      ZoneSettings,
    ][]) {
      const existing = nextZones[zoneKey] ?? {};
      // Empty strings explicitly clear that field (e.g. preset wants
      // to clear backgroundColor). Spread existing first, then preset.
      nextZones[zoneKey] = { ...existing, ...settings };
      // Clean empty-string values so the API zod schema accepts the
      // payload (zod-trip on empty strings depending on field shape).
      const cleaned: ZoneSettings = {};
      for (const [k, v] of Object.entries(nextZones[zoneKey] ?? {})) {
        if (typeof v === 'string' && v.trim()) {
          cleaned[k as keyof ZoneSettings] = v;
        }
      }
      nextZones[zoneKey] = cleaned;
    }
    setTypo(t => ({ ...t, zones: nextZones }));
    toastSuccess(
      isAr ? 'تم تطبيق النمط' : 'Style applied',
      isAr
        ? `${preset.labelAr} — يمكنك تعديل أي قسم منفردًا`
        : `${preset.label} — tweak any zone individually after`
    );
  };

  // Reset just the heading sub-zones to their inherit-from-template
  // defaults. Useful when the merchant wants to start fresh on the
  // heading styling without nuking unrelated zones (header, footer, etc.).
  const clearHeadingStyles = () => {
    const nextZones = { ...typo.zones };
    for (const zoneKey of HEADING_PRESET_ZONES) {
      delete nextZones[zoneKey];
    }
    setTypo(t => ({ ...t, zones: nextZones }));
    toastSuccess(
      isAr ? 'تم مسح أنماط العناوين' : 'Heading styles cleared',
      isAr ? 'العناوين عادت إلى الخط الافتراضي للقالب' : 'Headings reverted to template default'
    );
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
              {isAr ? 'العودة للمتجر' : 'Back to Store'}
            </Button>
          </Link>
          <button
            type="button"
            onClick={async () => {
              const confirmMsg = isAr
                ? 'سيتم حذف كل خطوط Google + كل إعدادات الأقسام (الألوان، الشارات، التسطير، الخطوط) والعودة لإعدادات القالب الافتراضية. سيتم تحديث الصفحة بعد ذلك. هل أنت متأكد؟'
                : 'This will remove ALL Google fonts + every zone setting (colours, chips, underlines, fonts) and revert to your template defaults. The page will reload after. Are you sure?';
              if (!confirm(confirmMsg)) return;
              // EMPTY_TYPOGRAPHY = { fonts: [], zones: {} } — explicit
              // truly-blank state. No baked defaults, so storefront falls
              // back to the active template's CSS for every zone.
              const blank: Typography = { fonts: [], zones: {} };
              setTypo(blank);
              const ok = await save(blank);
              if (ok) {
                // Hard reload after reset:
                //   1. Forces every <input type="color"> swatch to
                //      re-render from the now-empty state. React's
                //      controlled inputs occasionally keep a stale
                //      swatch on some browsers when value flips
                //      undefined → string-fallback.
                //   2. Re-fetches the live storefront probe iframe so
                //      its measured values match the reset state.
                //   3. Drops any stale closure references to the
                //      previous `typo` state inside event handlers.
                //   4. Belt-and-braces alongside the API's redis cache
                //      invalidation — guarantees the next page render
                //      sees the truly-blank state.
                toastSuccess(
                  isAr ? 'تم إعادة الضبط' : 'Typography reset',
                  isAr
                    ? 'كل الإعدادات الآن تورث من القالب النشط'
                    : 'All settings now inherit from the active template'
                );
                // Brief delay so the merchant sees the success toast
                // before the page reloads.
                setTimeout(() => window.location.reload(), 600);
              }
            }}
            disabled={saving}
            className="px-3 py-2 text-sm border border-destructive/40 text-destructive rounded-lg hover:bg-destructive/5 font-medium disabled:opacity-60"
            title={
              isAr
                ? 'حذف كل إعدادات الطباعة والعودة لإعدادات القالب الافتراضية'
                : 'Reset every typography setting to template defaults'
            }
          >
            {isAr ? 'إعادة تعيين الكل' : 'Reset all'}
          </button>
          <button
            type="button"
            onClick={() => save(typo)}
            disabled={saving}
            className="px-4 py-2 text-sm bg-primary text-white rounded-lg hover:bg-primary/90 font-medium disabled:opacity-60"
          >
            {saving ? (isAr ? 'جاري الحفظ…' : 'Saving…') : isAr ? 'حفظ التغييرات' : 'Save changes'}
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
            <h2 className="text-base font-semibold text-foreground">
              {isAr ? 'الأقسام' : 'Zones'}
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {isAr
                ? 'كل قسم يلف منطقة في كل قالب عبر سمات data-zone في المتجر. اترك أي حقل فارغًا ليرث من القالب النشط.'
                : "Each zone wraps a region of every template via the storefront's data-zone attributes. Leave a field blank to inherit from the active template."}
            </p>

            {/* Quick heading style presets — one click applies a coherent
                look across kicker + title + subtitle + seeAll. Best-of-both
                onboarding: merchant gets a polished section heading
                without editing 4 zones one by one, can still tweak each
                zone afterwards if they want a custom touch. */}
            <div className="mt-4 rounded-xl border border-primary/20 bg-primary/[0.02] p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-foreground">
                    {isAr ? 'أنماط جاهزة للعناوين' : 'Quick heading styles'}
                  </h3>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {isAr
                      ? 'انقر نمطًا لتطبيقه على الشارة + العنوان + النص الفرعي + رابط "عرض الكل" دفعة واحدة. يمكنك بعدها تعديل أي قسم منفردًا.'
                      : 'Click a style to apply it across kicker + title + subtitle + seeAll at once. Tweak any zone individually after.'}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={clearHeadingStyles}
                  className="shrink-0 rounded-lg border border-destructive/40 px-2.5 py-1 text-xs font-medium text-destructive hover:bg-destructive/5"
                >
                  {isAr ? 'مسح أنماط العناوين' : 'Clear heading styles'}
                </button>
              </div>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {HEADING_STYLE_PRESETS.map(p => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => applyHeadingPreset(p.id)}
                    className="group rounded-lg border border-border bg-background p-3 text-start hover:border-primary transition-colors"
                  >
                    {/* Mini preview rendered on a CHECKERED neutral
                        canvas so previews with light text (e.g. "Editorial
                        elegant" using brand-muted on the kicker) don't
                        vanish on a white card. The bg-foreground/[0.04]
                        tint gives enough contrast for any preset variation
                        while still reading as "preview canvas" not "real
                        UI". */}
                    <div
                      className="flex items-center justify-between gap-2 rounded-md bg-foreground/[0.05] px-3 py-2 ring-1 ring-foreground/5"
                      dir={isAr ? 'rtl' : 'ltr'}
                    >
                      <span
                        style={cfgToInlineStyle(
                          p.zoneSettings.sectionKicker ?? {},
                          currentStore?.theme
                        )}
                        className="text-[10px]"
                      >
                        {isAr ? 'استكشف' : 'EXPLORE'}
                      </span>
                      <span
                        style={cfgToInlineStyle(
                          p.zoneSettings.sectionTitle ?? {},
                          currentStore?.theme
                        )}
                        className="text-sm truncate flex-1 text-end"
                      >
                        {isAr ? 'أحدث المنتجات' : 'Latest Products'}
                      </span>
                    </div>
                    <div className="mt-2 text-xs font-semibold text-foreground">
                      {isAr ? p.labelAr : p.label}
                    </div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground leading-snug">
                      {isAr ? p.descriptionAr : p.description}
                    </div>
                  </button>
                ))}
              </div>
            </div>

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

                      {/* Live preview — mirrors the storefront emitter
                          so the merchant SEES the result of every field
                          edit immediately, without saving + reloading.
                          The preview text matches a real storefront
                          string for the zone (e.g. "Latest Products"
                          for sectionTitle) so the merchant can also
                          gauge real-world line length. */}
                      {/* Preview canvas uses a foreground-tinted bg so
                          previews with LIGHT text (brand-muted color,
                          white-on-tint chips, etc.) stay readable. The
                          previous bg-primary/[0.03] was too close to
                          white — "Editorial elegant" merging a muted
                          kicker into a near-white card disappeared into
                          the bg. */}
                      <div
                        className="mt-3 rounded-lg border border-dashed border-primary/30 bg-foreground/[0.05] ring-1 ring-foreground/5 p-4"
                        dir={isAr ? 'rtl' : 'ltr'}
                      >
                        <div className="mb-2 flex items-center justify-between">
                          <span className="text-[10px] uppercase tracking-wider text-primary/70 font-semibold">
                            {isAr ? 'معاينة مباشرة' : 'Live preview'}
                          </span>
                          <span className="text-[10px] text-muted-foreground/60">
                            {isAr
                              ? 'يتحدّث فوريًا مع كل تعديل'
                              : 'updates instantly with each change'}
                          </span>
                        </div>
                        <div className="min-h-[2rem] flex items-center">
                          <span style={cfgToInlineStyle(cfg, currentStore?.theme)}>
                            {isAr ? z.previewTextAr : z.previewText}
                          </span>
                        </div>
                      </div>

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
                                  : (resolveBrandPresetToHex(cfg.color, currentStore?.theme) ??
                                    '#000000')
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
                                    : (resolveBrandPresetToHex(
                                        cfg.backgroundColor,
                                        currentStore?.theme
                                      ) ?? '#FF7700')
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
                                      : (resolveBrandPresetToHex(
                                          cfg.textDecorationColor,
                                          currentStore?.theme
                                        ) ?? '#FF7700')
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
