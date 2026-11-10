/**
 * Render-path coverage gate for the custom product badge.
 *
 * CLAUDE.md, "Platform-level fixes": product-card UX lands on ALL render
 * paths — the shared Demo Store card, the five theme cards, the carousel and
 * the list item — plus the PDP, "or it isn't shipped". That rule is stated in
 * a markdown file, which makes it a preference; this file makes it a gate.
 *
 * A source scan rather than a render, on purpose. The rendering tests in
 * apps/web/src/templates/shared/product-card-badge-render.test.tsx prove the
 * core CARD paths behave; what a render test cannot catch is a FIFTH surface
 * being added later, or someone deleting the call from the PDP — whose
 * component is too entangled (cart, features, pixels, dynamic imports) to
 * render in a unit test. The failure this gate exists to prevent is silent
 * and shaped exactly like the one CLAUDE.md warns about: the badge works on
 * three surfaces and quietly does not exist on the fourth, which is the one
 * the merchant happens to look at.
 *
 * It also pins the two data hops the badge has to survive on its way to a
 * card — the explicit whitelist adapter and the public API select — because
 * both are places where a field is dropped without any error at all.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** The four core product-card render paths, exactly as CLAUDE.md enumerates them. */
const CARD_RENDER_PATHS = [
  'apps/web/src/templates/shared/StorefrontProductCard.tsx',
  'apps/web/src/templates/base/ProductCard.tsx',
  'apps/web/src/templates/shared/ProductCarousel.tsx',
  'apps/web/src/app/products/ProductListItem.tsx',
] as const;

/** The product detail page — a badge that vanishes on the product's own page
 *  is the same defect class as one missing from a card. */
const PDP = 'apps/web/src/app/products/[slug]/ProductDetailClient.tsx';

describe('custom badge — every product-card render path resolves it', () => {
  it('there are exactly four core card render paths (adding one is a deliberate act)', () => {
    // If this number changes, the new path needs the badge too — that is the
    // whole point of pinning it.
    expect(CARD_RENDER_PATHS).toHaveLength(4);
    for (const file of CARD_RENDER_PATHS) {
      expect(fs.existsSync(path.join(ROOT, file))).toBe(true);
    }
  });

  it.each(CARD_RENDER_PATHS)('%s calls resolveCardBadges', file => {
    expect(read(file)).toContain('resolveCardBadges(');
  });

  it.each(CARD_RENDER_PATHS)('%s renders customBadgeText', file => {
    // Resolving it and never rendering it is the same as not shipping it.
    expect(read(file)).toContain('{customBadgeText}');
  });

  it('the PDP resolves and renders it too', () => {
    // Source-level, and deliberately EXACT. `ProductDetailClient` drags in the
    // cart, feature flags, marketing pixels and half a dozen dynamic imports,
    // so it is not unit-renderable the way the cards are — which means
    // this gate is the only thing standing between the PDP and a badge that
    // silently stops rendering. A `toContain('pdpCustomBadgeText')` would have
    // been satisfied by `{false && pdpCustomBadgeText && (`, a dead branch
    // that still mentions the name; the exact conditional is what makes the
    // assertion mean "it renders", not "the word appears".
    const pdp = read(PDP);
    expect(pdp).toContain('resolveCardBadges(');
    expect(pdp).toContain('customBadgeText: pdpCustomBadgeText');
    expect(pdp).toContain('{pdpCustomBadgeText && (');
    expect(pdp).toContain('backgroundColor: pdpCustomBadgeColor');
    expect(pdp).toContain('{pdpCustomBadgeText}');
    // No dead gate in front of it.
    expect(pdp).not.toMatch(/\{\s*(false|0|null)\s*&&\s*pdpCustomBadgeText/);
  });

  it('no render path re-implements the mutex locally', () => {
    // The three rules live in custom-badge.ts. A card that computes its own
    // `orderable &&` or corner comparison is a second answer to the same
    // question, and the two will drift.
    for (const file of [...CARD_RENDER_PATHS, PDP]) {
      const src = read(file);
      expect(src).not.toMatch(/getCustomBadgeText\s*\(/);
      expect(src).not.toMatch(/CUSTOM_BADGE_DEFAULT_POSITION/);
    }
  });
});

describe('custom badge — the data hops it must survive', () => {
  it('the storefront product select carries both columns', async () => {
    // STOREFRONT_PRODUCT_SELECT is an explicit allowlist: a column missing
    // here reaches no card at all, with no error anywhere.
    // Behaviour: the exported select object itself (no text window over product.service.ts).
    const { STOREFRONT_PRODUCT_SELECT } = await import('@api/services/product.service');
    expect(STOREFRONT_PRODUCT_SELECT.badgeLabel).toBe(true);
    expect(STOREFRONT_PRODUCT_SELECT.badgeLabelAr).toBe(true);
  });

  it('toTemplateProduct carries both fields', () => {
    // The adapter is a hand-written whitelist — the same shape of hole.
    const src = read('apps/web/src/templates/adapters.ts');
    expect(src).toContain('badgeLabel:');
    expect(src).toContain('badgeLabelAr:');
  });

  it('the recommendation select carries both columns', () => {
    // FBT + "You might also like" render through the SAME canonical card
    // components, from a narrower select of their own.
    const src = read('apps/api/src/services/recommendation.service.ts');
    expect(src).toContain('badgeLabel: true');
    expect(src).toContain('badgeLabelAr: true');
  });

  it('the update payload schema lists both fields (Zod strips unlisted keys)', () => {
    const src = read('apps/api/src/routes/product.routes.ts');
    expect(src).toContain('badgeLabel: badgeLabelSchema');
    expect(src).toContain('badgeLabelAr: badgeLabelSchema');
  });

  it('the store-layout schema lists customBadge (Zod strips unlisted keys)', () => {
    // The recurring silent-strip trap called out in store-layout.ts: a key
    // absent from this schema is dropped on every PUT, so the merchant's
    // corner/colour save "succeeds" and changes nothing.
    // The layout Zod schema moved to shared with the visual builder registry
    // (the API route re-exports it).
    expect(read('packages/shared/src/builder/layout-schema.ts')).toContain('customBadge: z');
  });

  it('the admin exposes both inputs (every column with meaning gets a UI)', () => {
    const sidebar = read(
      'apps/admin/src/app/stores/[id]/products/[productId]/edit/_components/EditSidebar.tsx'
    );
    expect(sidebar).toContain("tFields('badgeLabel')");
    expect(sidebar).toContain("tFields('badgeLabelAr')");
    // …and the styling knobs live in the visual editor's page settings next to the discount
    // badge's, not in a new bespoke system.
    expect(read('packages/shared/src/builder/page-settings.ts')).toContain(
      "'customBadge.position'"
    );
  });
});

describe('custom badge — the migration is additive', () => {
  const MIGRATION =
    'packages/database/prisma/migrations/20260907120000_product_custom_badge/migration.sql';

  it('adds nullable columns and nothing else', () => {
    const sql = read(MIGRATION);
    expect(sql).toContain('ADD COLUMN "badge_label"');
    expect(sql).toContain('ADD COLUMN "badge_label_ar"');
    // Nullable by construction: no NOT NULL, no DEFAULT, no backfill. Every
    // existing row keeps rendering exactly what it renders today.
    expect(sql).not.toMatch(/badge_label(_ar)?"\s+VARCHAR\(32\)\s+NOT NULL/);
    expect(sql).not.toMatch(/ADD COLUMN "badge_label[^"]*"[^,;]*DEFAULT/);
    expect(sql).not.toMatch(/\bUPDATE\s+"products"/i);
    expect(sql).not.toMatch(/\bDROP\b/i);
  });

  it('caps the column at the DB layer at the same length as the Zod schema', () => {
    const sql = read(MIGRATION);
    expect(sql).toContain('VARCHAR(32)');
    expect(read('packages/shared/src/types/index.ts')).toContain(
      'export const PRODUCT_BADGE_LABEL_MAX_LENGTH = 32;'
    );
    expect(read('packages/database/prisma/schema.prisma')).toContain('@db.VarChar(32)');
  });
});
