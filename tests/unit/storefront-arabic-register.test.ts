/**
 * Ruling FU46-Y02a (Ahmad 2026-10-16, supersedes FU46-Y02): a FULL SENTENCE the storefront
 * generates is Egyptian Arabic ("طلبك اتسجل", "يوصلك بين …", "سلتك فاضية"); a short button or
 * label stays a neutral form that reads right in both registers ("أرسل الإيصال", "موعد الوصول").
 *
 * Three locks, so the register cannot drift back:
 *  1. MSA-only sentence markers (words with no Egyptian reading: "هذا", "لم", "يرجى", "سوف",
 *     "حالياً", "جارٍ", the MSA dual "قطعتان"...) are counted per file over every Arabic string
 *     literal in `apps/web/src` + `packages/ui/src` (and the shopper `messageAr` answers of the API).
 *     A file not in BASELINE must have none; a file in it may only go DOWN, and when it does the
 *     number here must be lowered with it (shrink-only ratchet). The baseline is the MSA copy that
 *     predates the 2026-10-16 decision (checkout errors, legal pages, FAQ defaults, review flow);
 *     converting it is a copy pass waiting on Ahmad (Ruling FU46-Y02b).
 *  2. The Egyptian sentence set Ahmad asked for is pinned verbatim (EGYPTIAN), so a sweep that
 *     "standardises" them turns this red even if it only uses words the marker list misses.
 *  3. The neutral button/label forms are pinned too (NEUTRAL), so the reverse drift is caught.
 *
 * NOT in scope: `components/landing/` (Ebda's own marketing landing), the admin, help and merchant
 * docs (merchant voice), and anything a merchant types (data, never in code).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '../..');

/** Words with no Egyptian-colloquial reading. A whole-word match, so they cannot fire inside a word. */
export const MSA_ONLY = [
  'هذا',
  'هذه',
  'لم',
  'لن',
  'سوف',
  'حالياً',
  'حاليا',
  'يرجى',
  'جارٍ',
  'يوجد',
  'لقد',
  'الذي',
  'التي',
  'الذين',
  'سنرد',
  'سيراجع',
  'ستظهر',
  'سيظهر',
  'يصلك',
  'أولاً',
  'قطعتان',
  'يومان',
  'نتيجتان',
  'يمكنك',
  'لديك',
  'إذا',
];
const AR = '\\u0621-\\u065F\\u0670\\u0640';
const WORD = new RegExp(`(?:^|[^${AR}])(${MSA_ONLY.join('|')})(?=$|[^${AR}])`, 'g');
const STRING = /(['"`])((?:(?!\1)[^\\\n]|\\.)*[ء-ي](?:(?!\1)[^\\\n]|\\.)*)\1/g;

/**
 * MSA sentence markers that predate the decision, per file. Shrink-only: lower a number when you
 * convert a sentence to Egyptian; never raise one (write the new sentence in Egyptian instead).
 */
const BASELINE: Record<string, number> = {
  // BASELINE_START (generated: node scripts in the test's failure message; do not hand-raise)
  'apps/web/src/app/account/AccountDashboardClient.tsx': 1,
  'apps/web/src/app/account/addresses/AddressesClient.tsx': 2,
  'apps/web/src/app/account/loyalty/LoyaltyClient.tsx': 2,
  'apps/web/src/app/account/orders/OrdersClient.tsx': 1,
  'apps/web/src/app/account/orders/[id]/OrderDetailClient.tsx': 1,
  'apps/web/src/app/account/settings/SettingsClient.tsx': 4,
  'apps/web/src/app/account/wallet/WalletClient.tsx': 6,
  'apps/web/src/app/affiliate/page.tsx': 3,
  'apps/web/src/app/auth/check-email/CheckEmailClient.tsx': 1,
  'apps/web/src/app/auth/reset-password/ResetPasswordClient.tsx': 3,
  'apps/web/src/app/auth/verify-email/VerifyEmailClient.tsx': 6,
  'apps/web/src/app/blog/page.tsx': 2,
  'apps/web/src/app/bundles/BundlesClient.tsx': 1,
  'apps/web/src/app/bundles/[slug]/BundleDetailClient.tsx': 1,
  'apps/web/src/app/cart/CartClient.tsx': 4,
  'apps/web/src/app/categories/CategoriesClient.tsx': 1,
  'apps/web/src/app/checkout/CheckoutClient.tsx': 44,
  'apps/web/src/app/checkout/OrderSummary.tsx': 1,
  'apps/web/src/app/checkout/PaymentStep.tsx': 2,
  'apps/web/src/app/checkout/_lib/checkoutErrors.ts': 1,
  'apps/web/src/app/checkout/error/ErrorClient.tsx': 1,
  'apps/web/src/app/checkout/success/FawryReferenceCard.tsx': 1,
  'apps/web/src/app/checkout/success/InstapayCard.tsx': 5,
  'apps/web/src/app/checkout/success/SuccessClient.tsx': 7,
  'apps/web/src/app/faq/FAQClient.tsx': 12,
  'apps/web/src/app/global-error.tsx': 1,
  'apps/web/src/app/locations/LocationsClient.tsx': 2,
  'apps/web/src/app/privacy/PrivacyClient.tsx': 12,
  'apps/web/src/app/products/ProductsClient.tsx': 1,
  'apps/web/src/app/products/[slug]/ProductDetailClient.tsx': 3,
  'apps/web/src/app/returns/ReturnsClient.tsx': 3,
  'apps/web/src/app/review/[orderId]/[productId]/ReviewErrorView.tsx': 7,
  'apps/web/src/app/review/[orderId]/[productId]/ReviewForm.tsx': 9,
  'apps/web/src/app/search/SearchClient.tsx': 1,
  'apps/web/src/app/terms/TermsClient.tsx': 11,
  'apps/web/src/app/wishlist/WishlistClient.tsx': 1,
  'apps/web/src/app/wishlist/shared/[userId]/SharedWishlistClient.tsx': 6,
  'apps/web/src/components/CmsPageContent.tsx': 1,
  'apps/web/src/components/CookieConsentBanner.tsx': 1,
  'apps/web/src/components/CookiePreferencesModal.tsx': 2,
  'apps/web/src/components/FrequentlyBoughtTogether.tsx': 2,
  'apps/web/src/components/ReviewSection.tsx': 8,
  'apps/web/src/components/RouteErrorFallback.tsx': 3,
  'apps/web/src/components/SearchAutocomplete.tsx': 1,
  'apps/web/src/components/SectionErrorBoundary.tsx': 1,
  'apps/web/src/components/SectionRetryNotice.tsx': 1,
  'apps/web/src/components/StoreMaintenance.tsx': 2,
  'apps/web/src/components/VariantSelector.tsx': 4,
  'apps/web/src/contexts/CartContext.tsx': 3,
  'apps/web/src/contexts/LanguageContext.tsx': 17,
  'apps/web/src/lib/bundle-cart-errors.ts': 4,
  'apps/web/src/lib/checkout-bundle-errors.ts': 10,
  'apps/web/src/lib/product-cart-errors.ts': 5,
  'apps/web/src/templates/classic/OrderSummary.tsx': 1,
  'apps/web/src/templates/dahab/CartDrawer.tsx': 1,
  'apps/web/src/templates/dahab/ProductGrid.tsx': 1,
  'apps/web/src/templates/elegant/Header.tsx': 1,
  'apps/web/src/templates/elegant/ProductGrid.tsx': 1,
  'apps/web/src/templates/modern/ProductGrid.tsx': 1,
  'apps/web/src/templates/shared/CartLineUnavailable.tsx': 2,
  'apps/web/src/templates/shared/WaMeButtons.tsx': 1,
  // BASELINE_END
};
const API_BASELINE: Record<string, number> = {
  // API_BASELINE_START
  // API_BASELINE_END
};

/** Ahmad's Egyptian sentences (2026-10-16), pinned in the file that renders them. */
const EGYPTIAN: Array<[string, string]> = [
  ['apps/web/src/components/commerce/ReceiptPrinter.tsx', 'طلبك اتسجل، الدفع عند الاستلام'],
  ['apps/web/src/components/commerce/ReceiptPrinter.tsx', 'طلبك اتسجل، في انتظار الدفع'],
  ['apps/web/src/components/commerce/ReceiptPrinter.tsx', 'تم الدفع، طلبك اتأكد'],
  ['apps/web/src/components/commerce/ReceiptPrinter.tsx', 'بنطبع فاتورتك…'],
  ['apps/web/src/components/commerce/ReceiptPrinter.tsx', 'الدفع ما تمش'],
  ['apps/web/src/components/commerce/ReceiptPrinter.tsx', 'عندك سؤال؟ كلّم المتجر على واتساب'],
  ['apps/web/src/components/commerce/DeliveryChip.tsx', 'يوصلك بين'],
  ['apps/web/src/components/commerce/DeliveryChip.tsx', 'بيتجهز خصيصًا لك في'],
  ['apps/web/src/app/checkout/success/InstapayReceiptUploader.tsx', 'صاحب المتجر هيراجع التحويل'],
  ['apps/web/src/app/checkout/success/InstapayReceiptUploader.tsx', 'الإيصال اتبعت.'],
  ['apps/web/src/app/contact/ContactClient.tsx', 'هنرد عليك في أقرب وقت.'],
  ['apps/web/src/components/UnknownHostNotFound.tsx', 'المتجر ده مش موجود أو لسه ما فتحش'],
  ['apps/web/src/components/demo/DemoCheckoutNotice.tsx', 'ده متجر تجريبي — الطلب مقفول'],
  ['apps/web/src/templates/dahab/CartDrawer.tsx', 'سلتك فاضية'],
  ['apps/web/src/lib/return-policy-text.ts', 'لو الطلب مش مناسبك، تقدر ترجعه خلال'],
  ['apps/web/src/lib/plural.ts', "two: 'قطعتين'"],
  ['apps/web/src/lib/plural.ts', "two: 'يومين'"],
  ['apps/api/src/routes/public.routes.ts', 'ده متجر تجريبي — الرسائل مقفولة'],
];

/** Short buttons and labels stay neutral (decision e): pinned so a sentence sweep leaves them be. */
const NEUTRAL: Array<[string, string]> = [
  ['apps/web/src/app/checkout/success/InstapayReceiptUploader.tsx', "'أرسل الإيصال'"],
  ['apps/web/src/components/ProductModel3d.tsx', "'اعرضه 3D'"],
  ['apps/web/src/components/ProductModel3d.tsx', "'اعرضه في مكانك'"],
  ['apps/web/src/components/UnknownHostNotFound.tsx', "'أنشئ متجرك على إبدأ'"],
  ['apps/web/src/components/UnknownHostNotFound.tsx', "'تواصل معنا عبر واتساب'"],
  ['apps/web/src/components/commerce/ReceiptPrinter.tsx', "'موعد الوصول'"],
  ['apps/web/src/components/demo/DemoLookBar.tsx', "'اختر شكلاً'"],
];

function files(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) {
      if (n === 'node_modules' || n === '__tests__' || n === 'landing') continue;
      files(p, out);
    } else if (/\.tsx?$/.test(n) && !/\.(test|spec|d)\.tsx?$/.test(n)) out.push(p);
  }
  return out;
}

/** MSA-marker hits per repo-relative file. */
export function msaHits(paths: string[], only?: RegExp): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const f of paths) {
    readFileSync(f, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        const t = line.trim();
        if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
        if (only && !only.test(line)) return;
        for (const m of line.matchAll(STRING)) {
          for (const w of m[2].matchAll(WORD)) {
            const rel = relative(ROOT, f);
            (out[rel] ??= []).push(`${rel}:${i + 1} «${w[1]}» in ${m[2].slice(0, 80)}`);
          }
        }
      });
  }
  return out;
}

function ratchet(found: Record<string, string[]>, baseline: Record<string, number>): string[] {
  const problems: string[] = [];
  for (const [file, list] of Object.entries(found)) {
    const allowed = baseline[file] ?? 0;
    if (list.length > allowed)
      problems.push(
        `${file}: ${list.length} MSA sentence markers, baseline ${allowed}. Write the new sentence in Egyptian Arabic (Ruling FU46-Y02a):\n  ${list.join('\n  ')}`
      );
  }
  for (const [file, allowed] of Object.entries(baseline)) {
    const n = found[file]?.length ?? 0;
    if (n < allowed)
      problems.push(`${file}: now ${n} MSA markers — lower its baseline from ${allowed} to ${n}.`);
  }
  return problems;
}

const storefrontPaths = () => [
  ...files(join(ROOT, 'apps/web/src')),
  ...files(join(ROOT, 'packages/ui/src')),
];

describe('storefront Arabic register (Ruling FU46-Y02a: Egyptian sentences, neutral labels)', () => {
  it('no NEW MSA sentence in a storefront string (shrink-only baseline)', () => {
    const paths = storefrontPaths();
    expect(paths.length).toBeGreaterThan(200);
    expect(ratchet(msaHits(paths), BASELINE)).toEqual([]);
  });

  it('no NEW MSA sentence in an Arabic answer the API gives a shopper (`messageAr`)', () => {
    const found = msaHits(files(join(ROOT, 'apps/api/src')), /messageAr/);
    expect(ratchet(found, API_BASELINE)).toEqual([]);
  });

  it("Ahmad's Egyptian sentences are in the files that render them", () => {
    const missing = EGYPTIAN.filter(([f, s]) => !readFileSync(join(ROOT, f), 'utf8').includes(s));
    expect(missing).toEqual([]);
  });

  it('short buttons and labels keep their neutral form', () => {
    const missing = NEUTRAL.filter(([f, s]) => !readFileSync(join(ROOT, f), 'utf8').includes(s));
    expect(missing).toEqual([]);
  });

  it('the matcher catches the MSA sentence shapes and leaves Egyptian alone (self-test)', () => {
    const hit = (s: string) => [...s.matchAll(WORD)].length > 0;
    for (const s of [
      'تم تسجيل طلبك، يصلك بين',
      'هذا متجر تجريبي',
      'لم يكتمل الدفع',
      'يرجى إدخال البيانات',
      'قطعتان',
      'المتجر غير متاح حالياً',
      'سيراجع صاحب المتجر التحويل',
    ])
      expect(hit(s), s).toBe(true);
    for (const s of [
      'طلبك اتسجل',
      'يوصلك بين',
      'هيوصلك خلال يومين',
      'ده متجر تجريبي',
      'الدفع ما تمش',
      'قطعتين',
      'المتجر مش متاح دلوقتي',
      'لمّا',
      'التيشيرت',
      'يلمع',
      'الهدية',
    ])
      expect(hit(s), s).toBe(false);
  });
});
