/**
 * Guard: the 55 admin files translated for B2 (admin i18n coverage) must
 * never regress a hardcoded English string back into JSX.
 *
 * The file list is intentionally inlined here (not read from the throwaway
 * `.b2-files.txt` planning dotfile at the repo root, which isn't committed)
 * so this test is self-contained and keeps working after that file is
 * deleted.
 *
 * Heuristic (matches the admin i18n audit heuristic):
 *   - JSX text node:      />\s*[A-Za-z][A-Za-z ,.'!?:()&/-]{2,}\s*</
 *   - Chrome attribute:   /\b(placeholder|title|aria-label|label|alt)="[^"]{2,}"/
 *
 * A hit is allowed through only if its exact inner text is in ALLOWLIST
 * below, with a reason. Every allowlisted entry is one of:
 *   - a locale-matched EXAMPLE VALUE for a genuine bilingual content-data
 *     field pair (e.g. a Kicker (EN) input next to a Kicker (AR) input,
 *     where the placeholder shows what to type in that language) — not
 *     admin chrome, so it isn't translated via next-intl;
 *   - a code/URL/hex/token-syntax example placeholder;
 *   - a currency code or other unit-as-code value (KWD);
 *   - a brand/person example value (Ahmad);
 *   - TypeScript syntax the naive regex mistakes for JSX text (generic
 *     brackets, ternaries, comparisons) — not a string at all.
 *
 * To prove this test can fail: temporarily hardcode a new English string
 * into any of the 55 files below (e.g. replace a `{t('foo')}` call with
 * literal JSX text) and re-run — the test must go red. Restore afterwards.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const ADMIN_SRC = resolve(__dirname, '../../apps/admin/src');

// The 55 files translated for B2 admin i18n coverage (paths relative to
// apps/admin/src), largest-hardcoded-string-count first per the 2026-09-25
// audit.
const B2_FILES = [
  'app/stores/[id]/page-builder/page.tsx',
  'app/stores/[id]/floating-widget/page.tsx',
  'app/stores/[id]/ai-tools/_components/AiSweepResultsPanels.tsx',
  'app/stores/[id]/orders/new/page.tsx',
  'components/ZoneEditor.tsx',
  'app/stores/[id]/features/FeatureMatrix.tsx',
  'app/stores/[id]/ai-tools/_components/GeoResultsPanel.tsx',
  'app/stores/[id]/products/[productId]/recommendations/_components/AiSuggestionsPanel.tsx',
  'app/stores/[id]/orders/[orderId]/_components/PaymentLinkButton.tsx',
  'app/users/[id]/page.tsx',
  'app/stores/[id]/categories/page.tsx',
  'app/stores/[id]/finance/expenses/new/page.tsx',
  'app/stores/[id]/stock/suppliers/new/page.tsx',
  'app/stores/[id]/loyalty/transactions/page.tsx',
  'app/stores/[id]/shipping/_components/AreaRateEditor.tsx',
  'app/stores/[id]/products/[productId]/edit/_components/ProductFaqSection.tsx',
  'app/stores/[id]/orders/[orderId]/_components/RefundButton.tsx',
  'lib/auth.tsx',
  'components/whatsapp/BotCopyTab.tsx',
  'components/payment-events/PaymentEventsTimeline.tsx',
  'components/ColorField.tsx',
  'app/stores/[id]/customers/page.tsx',
  'app/stores/[id]/categories/CategoryForm.tsx',
  'app/answer-engine-providers/page.tsx',
  'components/whatsapp/PaymentLinkTab.tsx',
  'components/mobile/BottomSheet.tsx',
  'components/admin-layout/SidebarHeader.tsx',
  'components/SectionPreview.tsx',
  'app/stores/[id]/products/[productId]/edit/page.tsx',
  'app/stores/[id]/insights/segments/page.tsx',
  'app/stores/[id]/finance/bank-reconciliation/import/page.tsx',
  'app/stores/[id]/bulk/_components/BulkExportPanel.tsx',
  'app/stores/[id]/affiliates/[affiliateId]/audit-trail/page.tsx',
  'app/account/security/page.tsx',
  'components/whatsapp/TemplatesTab.tsx',
  'components/whatsapp/ConnectionTab.tsx',
  'components/admin-layout/HubTabs.tsx',
  'components/SmartPaletteModal.tsx',
  'components/NavMenuEditor.tsx',
  'components/ImageUpload.tsx',
  'components/FooterLinksEditor.tsx',
  'components/ColorContrastPreview.tsx',
  'app/stores/new/_components/StepIndicator.tsx',
  'app/stores/[id]/stock/dashboard/page.tsx',
  'app/stores/[id]/shipping/page.tsx',
  'app/stores/[id]/products/[productId]/edit/_components/AiFieldBadge.tsx',
  'app/stores/[id]/page.tsx',
  'app/stores/[id]/orders/[orderId]/_components/RefreshRefundStatusButton.tsx',
  'app/stores/[id]/orders/[orderId]/_components/RefreshPaymentButton.tsx',
  'app/stores/[id]/orders/[orderId]/_components/ItemsCard.tsx',
  'app/stores/[id]/orders/[orderId]/_components/ActionFooter.tsx',
  'app/stores/[id]/bulk/_components/BulkImportWizard.tsx',
  'app/stores/[id]/branding/_components/ThemeTab.tsx',
  'app/stores/[id]/affiliates/_components/AffiliatesTable.tsx',
  'app/layout.tsx',
] as const;

// Exact inner-text matches allowed to remain hardcoded. Keep this list
// tight — every entry should map to one of the reasons in the file header.
const ALLOWLIST = new Set<string>([
  // --- code / URL / token-syntax examples -----------------------------
  '#FFFFFF or token:primary or leave empty',
  '#RRGGBB',
  'exact slug as in /products?category=<slug>',
  'https://...',
  'https://fonts.googleapis.com/css2?family=...',
  'https://r2.dev/.../track.mp3',
  'https://…',
  'https://…/icon.png',
  'https://…/icon.svg',
  '+965 …',
  '+96512345678',
  '0.000',
  'info@store.com',
  'supplier@example.com',

  // --- currency code / brand-ish example values -----------------------
  'KWD',
  'Ahmad',

  // --- locale-matched EXAMPLE VALUES for genuine bilingual content-data
  //     field pairs (English placeholder + its Arabic sibling) ---------
  'Add to cart',
  'أضف للسلة',
  'Out of stock',
  'نفد المخزون',
  'Open menu',
  'القائمة',
  "Hi! I'd like to ask about…",
  'Question about your store',
  'Optional notes in English',
  'ملاحظات بالعربية (اختياري)',
  'اسم المورد بالعربية',
  'Area name',
  'اسم المنطقة',
  'e.g. 45',
  'e.g. Al Olaya',
  'مثال: العليا',
  'e.g. Al-Mutlaq Trading',
  'e.g. Available in S, M, L, XL.',
  'مثال: متوفر بمقاسات S وM وL وXL.',
  'e.g. Browse our top picks',
  'e.g. EXPLORE',
  'مثال: استكشف',
  "e.g. Editor's Picks",
  'مثال: اختيارات المحرر',
  'e.g. Riyadh',
  'مثال: الرياض',
  'e.g. Saudi Arabia',
  'مثال: المملكة العربية السعودية',
  'e.g. What sizes are available?',
  'مثال: ما الأحجام المتوفرة؟',
  'pieces',
  'قطعة',
  'مثال: تصفح أفضل اختياراتنا',

  // --- TypeScript syntax the naive regex mistakes for JSX text --------
  'Promise',
  'Record',
  'index',
  't(key as Parameters',
  't.has(key as Parameters',
  'tErrors(key as Parameters',
  "f.type.startsWith('image/') && f.size",
  'customer.address ? (',
  'customer.phone ? (',
  'previewLimit && (',
  'tx.order ? (',
]);

const JSX_TEXT_REGEX = />\s*([A-Za-z][A-Za-z ,.'!?:()&/-]{2,}?)\s*</g;
const CHROME_ATTR_REGEX = /\b(?:placeholder|title|aria-label|label|alt)="([^"]{2,})"/g;

function findHardcodedHits(source: string): string[] {
  const hits: string[] = [];
  let match: RegExpExecArray | null;

  JSX_TEXT_REGEX.lastIndex = 0;
  while ((match = JSX_TEXT_REGEX.exec(source))) {
    const inner = match[1];
    if (!ALLOWLIST.has(inner)) hits.push(`[text] ${inner}`);
  }

  CHROME_ATTR_REGEX.lastIndex = 0;
  while ((match = CHROME_ATTR_REGEX.exec(source))) {
    const inner = match[1];
    if (!ALLOWLIST.has(inner)) hits.push(`[attr] ${inner}`);
  }

  return hits;
}

describe('admin i18n: no hardcoded strings in the B2-translated files', () => {
  it('lists exactly the 55 files this guard covers', () => {
    expect(B2_FILES.length).toBe(55);
    expect(new Set(B2_FILES).size).toBe(55); // no duplicates
  });

  it.each(B2_FILES)('%s has no un-allowlisted hardcoded strings', relativePath => {
    const fullPath = resolve(ADMIN_SRC, relativePath);
    expect(existsSync(fullPath), `file should exist: ${relativePath}`).toBe(true);

    const source = readFileSync(fullPath, 'utf8');
    const hits = findHardcodedHits(source);

    expect(hits, `hardcoded strings found in ${relativePath}:\n${hits.join('\n')}`).toEqual([]);
  });
});
