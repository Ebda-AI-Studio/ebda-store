/**
 * Guard: the 82 admin files translated for B2 (admin i18n coverage, parts 1
 * + 2) must never regress a hardcoded English string back into JSX.
 *
 * The file list is intentionally inlined here (not read from the throwaway
 * `.b2-files.txt` planning dotfile at the repo root, which isn't committed)
 * so this test is self-contained and keeps working after that file is
 * deleted.
 *
 * Heuristic — tests/helpers/admin-i18n-heuristic.ts, TWO tiers:
 *   - STRICT (the original B2 audit heuristic): a JSX text node of plain
 *     letters/punctuation, and a double-quoted chrome attribute. Hard fail.
 *   - WIDENED (issue 2182 — the guard used to advertise coverage it could
 *     not enforce): text with digits/→/—/%, `title={'…'}`, capitalised
 *     ternary literals, and `header:`/`label:`-style props. A ratchet: a hit
 *     must be allowlisted (globally, or per-file in WIDENED_FILE_ALLOWLIST
 *     for content data / product names) or in admin-i18n-known-debt.json —
 *     empty since issue 2281 translated the 2026-10-01 snapshot. New ones
 *     fail, and a debt/allowlist entry whose string is gone fails too.
 * NOT enforced even now: template literals, text between two
 * interpolations (`{n} rows`), lower-case ternary literals, and every admin
 * file NOT in the list below. "This file is guarded" means exactly the
 * shapes above.
 *
 * A hit is allowed through only if its exact inner text is in ALLOWLIST
 * below, with a reason. Every allowlisted entry is one of:
 *   - a locale-matched EXAMPLE VALUE for a genuine bilingual content-data
 *     field pair (e.g. a Kicker (EN) input next to a Kicker (AR) input,
 *     where the placeholder shows what to type in that language) — not
 *     admin chrome, so it isn't translated via next-intl;
 *   - a code/URL/hex/token-syntax example placeholder;
 *   - a currency code or other unit-as-code value (EGP);
 *   - a brand/person example value (Ahmad);
 *   - TypeScript syntax the naive regex mistakes for JSX text (generic
 *     brackets, ternaries, comparisons) — not a string at all.
 *
 * To prove this test can fail: temporarily hardcode a new English string
 * into any of the 82 files below (e.g. replace a `{t('foo')}` call with
 * literal JSX text) and re-run — the test must go red. Restore afterwards.
 *
 * B2 part 2 (2026-09-25) covered 47 files flagged by the same audit
 * heuristic across the rest of the admin app (stock/finance/insights pages,
 * the platform AI-usage + webhook-inbox super-admin pages, etc.); 26 of them
 * are new and appended below the `// --- B2 part 2 ---` marker, the other
 * 21 were already in the part-1 list above (see the comment there).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import {
  findHardcodedHits as findStrictHits,
  findWidenedHits,
} from '../helpers/admin-i18n-heuristic';
import KNOWN_DEBT from './admin-i18n-known-debt.json';

const ADMIN_SRC = resolve(__dirname, '../../apps/admin/src');

// The 83 files this guard covers (82 + the 3D model card, 2026-10-07) (paths relative to apps/admin/src). Part 1
// (55 files, largest-hardcoded-string-count first) per the 2026-09-25 audit;
// 26 new part-2 files appended below (21 more part-2 files were already
// covered by part 1 and are not repeated).
const B2_FILES = [
  // Visual builder Phase 2 (2026-10-07) — new files, strict from day one.
  'app/stores/[id]/builder/page.tsx',
  'app/stores/[id]/builder/_components/BuilderEditor.tsx',
  'app/stores/[id]/builder/_components/SectionTree.tsx',
  'app/stores/[id]/builder/_components/AddSectionDialog.tsx',
  'app/stores/[id]/builder/_components/SettingsPanel.tsx',
  'app/stores/[id]/builder/_components/MediaPicker.tsx',
  'app/stores/[id]/builder/_components/ThemeSettingsPanel.tsx',
  'app/stores/[id]/builder/_components/RevisionsPanel.tsx',
  'app/stores/[id]/builder/_components/Canvas.tsx',
  // Product 3D models card (2026-10-07) — written translated from day one.
  'app/stores/[id]/products/[productId]/_components/Product3dModelCard.tsx',
  // Policy-change notify (Ruling LEGAL-4, 2026-10-15) — written translated from day one.
  'components/legal/LegalNoticeBanner.tsx',
  'components/legal/LegalAcceptancesPanel.tsx',
  'app/policy-updates/page.tsx',
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
  'components/payment-events/PaymentEventsTimeline.tsx',
  'components/ColorField.tsx',
  'app/stores/[id]/customers/page.tsx',
  'app/stores/[id]/categories/CategoryForm.tsx',
  'app/answer-engine-providers/page.tsx',
  'components/mobile/BottomSheet.tsx',
  'components/admin-layout/SidebarHeader.tsx',
  'components/SectionPreview.tsx',
  'app/stores/[id]/products/[productId]/edit/page.tsx',
  'app/stores/[id]/insights/segments/page.tsx',
  'app/stores/[id]/finance/bank-reconciliation/import/page.tsx',
  'app/stores/[id]/bulk/_components/BulkExportPanel.tsx',
  'app/stores/[id]/affiliates/[affiliateId]/audit-trail/page.tsx',
  'app/account/security/page.tsx',
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

  // --- B2 part 2 (2026-09-25) ---
  // 21 of the 47 files the part-2 audit flagged (BulkExportPanel,
  // BulkImportWizard, CategoryForm, categories/page, customers/page,
  // finance/expenses/new, floating-widget, loyalty/transactions,
  // orders/[orderId]/ItemsCard, page-builder, stores/[id]/page,
  // ProductFaqSection, AreaRateEditor, stock/suppliers/new, StepIndicator,
  // FooterLinksEditor, ImageUpload, NavMenuEditor, PaymentEventsTimeline,
  // lib/auth.tsx) were already covered by part 1
  // above and are NOT repeated here — their remaining hits were either
  // fixed in place or are pre-existing allowlisted exceptions.
  'app/ai-usage/page.tsx',
  'app/stores/[id]/ai-tools/page.tsx',
  'app/stores/[id]/ai-usage/page.tsx',
  'app/stores/[id]/domain/page.tsx',
  'app/stores/[id]/finance/bank-reconciliation/[statementId]/page.tsx',
  'app/stores/[id]/finance/dashboard/page.tsx',
  'app/stores/[id]/finance/expenses/page.tsx',
  'app/stores/[id]/finance/fx-rates/page.tsx',
  'app/stores/[id]/finance/journal/[entryId]/page.tsx',
  'app/stores/[id]/finance/reports/page.tsx',
  'app/stores/[id]/insights/cohorts/page.tsx',
  'app/stores/[id]/insights/dashboard/page.tsx',
  'app/stores/[id]/insights/funnel/page.tsx',
  'app/stores/[id]/merchant-keys/page.tsx',
  'app/stores/[id]/newsletter/page.tsx',
  'app/stores/[id]/products/_components/MassEditModal.tsx',
  'app/stores/[id]/stock/adjustments/new/page.tsx',
  'app/stores/[id]/stock/adjustments/page.tsx',
  'app/stores/[id]/stock/inventory/page.tsx',
  'app/stores/[id]/stock/purchase-orders/[poId]/page.tsx',
  'app/stores/[id]/stock/purchase-orders/new/page.tsx',
  'app/stores/[id]/stock/purchase-orders/page.tsx',
  'app/stores/[id]/stock/scan/page.tsx',
  'app/stores/[id]/stock/suppliers/page.tsx',
  'app/stores/[id]/stock/warehouses/page.tsx',
  'app/email-queue/page.tsx',
  'app/webhook-events/page.tsx',
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
  '0.00',
  'info@store.com',
  'supplier@example.com',
  'https://… (paste R2 upload URL)',
  'e.g. 550e8400-e29b-41d4-a716-446655440000',
  'MAIN',
  '30.0444',
  '31.2357',
  'e.g. 50.00',

  // --- currency code / brand-ish example values -----------------------
  'EGP',
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
  'Optional reason in English',
  'سبب التسوية بالعربية (اختياري)',
  'Main Warehouse',
  'المستودع الرئيسي',
  'Shuwaikh Industrial Area, Egypt',

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
  'w.isDefault ? (',
  'row.cachedHit ? (',
  'ev.resultOrderId ? (',
  'apiGet',
  'subs.length && (',
  'row.active ? (',
  // ThemeSettingsPanel tier list: JSX expression code between tags, not copy.
  'renderBlock( s,',
  'changed(String(s.id))) && (',
]);

const findHardcodedHits = (source: string) => findStrictHits(source, ALLOWLIST);

describe('findHardcodedHits catches a multi-line wrapped JSX text node (#1934)', () => {
  it('flags a hardcoded English paragraph wrapped across several lines', () => {
    // The dominant real-world shape a prettier-formatted long JSX text node
    // takes — the guard must not require it to be on one line.
    const fixture = `
      <p>
        This is a hardcoded English paragraph that a formatter has wrapped
        across several lines instead of leaving it on one.
      </p>
    `;
    const hits = findHardcodedHits(fixture);
    expect(hits.some(h => h.includes('This is a hardcoded English paragraph'))).toBe(true);
  });

  it('still flags the single-line case (no regression)', () => {
    const fixture = `<p>This is a hardcoded English sentence.</p>`;
    const hits = findHardcodedHits(fixture);
    expect(hits.some(h => h.includes('This is a hardcoded English sentence'))).toBe(true);
  });
});

describe('admin i18n: no hardcoded strings in the B2-translated files', () => {
  it('lists exactly the 90 files this guard covers', () => {
    // 81 + 9 visual builder files + the 3D model card + 3 policy-change notify files
    expect(B2_FILES.length).toBe(90);
    expect(new Set(B2_FILES).size).toBe(90); // no duplicates
  });

  it.each(B2_FILES)('%s has no un-allowlisted hardcoded strings', relativePath => {
    const fullPath = resolve(ADMIN_SRC, relativePath);
    expect(existsSync(fullPath), `file should exist: ${relativePath}`).toBe(true);

    const source = readFileSync(fullPath, 'utf8');
    const hits = findHardcodedHits(source);

    expect(hits, `hardcoded strings found in ${relativePath}:\n${hits.join('\n')}`).toEqual([]);
  });
});

describe('widened tier catches the shapes STRICT is blind to (issue 2182)', () => {
  const none = new Set<string>();
  it.each([
    [
      'text with an arrow',
      '<p className="x">You can find entry IDs in Finance → Journal.</p>',
      '[text+]',
    ],
    ['text with a digit', '<span>Import 3 files</span>', '[text+]'],
    [
      'attribute written as an expression',
      `<button title={'Turn off backorder'} />`,
      '[attr-expr]',
    ],
    [
      'capitalised ternary literal',
      `{receiving ? 'Receiving…' : tDetail('receiveButton')}`,
      '[ternary]',
    ],
    [
      'ternary inside an attribute',
      `title={on ? 'Turn off backorder' : 'Allow backorder'}`,
      '[ternary]',
    ],
    ['chrome-named object property', `const cols = [{ header: 'Product', key: 'p' }];`, '[prop]'],
  ])('%s', (_label, src, tag) => {
    const hits = findWidenedHits(src, none);
    expect(
      hits.some(h => h.startsWith(tag)),
      hits.join('\n')
    ).toBe(true);
  });

  it('a translated call site is clean in every tier', () => {
    const src = `<p>{t('hint')}</p><button title={t('x')} />{busy ? t('a') : t('b')}`;
    expect(findHardcodedHits(src)).toEqual([]);
    expect(findWidenedHits(src, none)).toEqual([]);
  });
});

// Widened hits that are NOT admin chrome, scoped to the one file where each
// is legitimate (a global ALLOWLIST entry like 'Products' would also wave
// through a real `header: 'Products'` anywhere else). Issue 2281.
const WIDENED_FILE_ALLOWLIST: Record<string, string[]> = {
  // Storefront nav/footer PRESET items: each English `label` sits next to its
  // `labelAr` sibling in the same object literal — bilingual content data the
  // merchant saves into the store theme and the storefront renders in the
  // shopper's language. Not admin chrome, so not a next-intl key.
  'components/NavMenuEditor.tsx': [
    '[prop] Products',
    '[prop] Categories',
    '[prop] About',
    '[prop] Contact',
    '[prop] Locations',
  ],
  'components/FooterLinksEditor.tsx': ['[prop] Contact', '[prop] Wishlist', '[prop] Locations'],
};

describe('admin i18n: widened-shape ratchet over the 81 files (issue 2182)', () => {
  const debt = KNOWN_DEBT as Record<string, string[]>;

  it('known debt only names covered files', () => {
    const covered = new Set<string>(B2_FILES);
    expect(Object.keys(debt).filter(f => !covered.has(f))).toEqual([]);
    expect(Object.keys(WIDENED_FILE_ALLOWLIST).filter(f => !covered.has(f))).toEqual([]);
  });

  // The ratchet only shrinks if a translated string's entry is deleted: an
  // entry whose string is gone would silently re-admit that exact string.
  it.each(Object.keys({ ...debt, ...WIDENED_FILE_ALLOWLIST }))(
    '%s: every known-debt / allowlisted widened entry still matches (delete stale ones)',
    relativePath => {
      const source = readFileSync(resolve(ADMIN_SRC, relativePath), 'utf8');
      const live = new Set(findWidenedHits(source, ALLOWLIST));
      const recorded = [
        ...(debt[relativePath] ?? []),
        ...(WIDENED_FILE_ALLOWLIST[relativePath] ?? []),
      ];
      expect(recorded.filter(h => !live.has(h))).toEqual([]);
    }
  );

  it.each(B2_FILES)('%s adds no NEW widened-shape hardcoded string', relativePath => {
    const source = readFileSync(resolve(ADMIN_SRC, relativePath), 'utf8');
    const known = new Set([
      ...(debt[relativePath] ?? []),
      ...(WIDENED_FILE_ALLOWLIST[relativePath] ?? []),
    ]);
    const fresh = findWidenedHits(source, ALLOWLIST).filter(h => !known.has(h));
    expect(
      fresh,
      `new hardcoded string(s) in ${relativePath} — translate them (en + ar), or allowlist with a reason:\n${fresh.join('\n')}`
    ).toEqual([]);
  });
});
