// One-time migration: seed a page-builder hero slide from the legacy
// per-store hero columns (heroTitle / heroSubtitle / heroCta* / heroImage)
// for any store that has NO `layout.hero.slides` yet.
//
// WHY: the legacy `/hero` admin page (writing the heroTitle… columns) is being
// retired in favor of the Page Builder hero (which writes layout.hero.slides[]).
// The storefront already prefers a slide when one exists and only falls back to
// the legacy columns when slides.length === 0 (see HomePageContent.tsx). Without
// this migration, retiring the editor would orphan whatever a merchant typed in
// /hero. Seeding a slide preserves the visible hero before the editor goes away.
//
// SAFETY:
//   - Idempotent: a store that already has ≥1 slide is skipped untouched.
//   - Non-destructive: the legacy columns are LEFT IN PLACE (the storefront
//     still reads them as the empty-state fallback; we only ADD a slide).
//   - A HeroSlide REQUIRES an `image` (storefront renders an image-based hero),
//     so we only seed a slide for stores that have a non-empty `heroImage`.
//     Stores with hero TEXT but no image keep working via the legacy fallback
//     and can build a proper slide in the Page Builder.
//   - mode is set to 'single' (one slide = a banner, not a carousel).
//
// FIELD MAP (legacy column → HeroSlide field, per @force/shared store-layout.ts):
//   heroImage      → image       (required)
//   heroTitle      → headline
//   heroTitleAr    → headlineAr
//   heroCtaText    → ctaText
//   heroCtaTextAr  → ctaTextAr
//   heroCtaLink    → ctaHref
//   (heroSubtitle / heroSubtitleAr have NO slide overlay equivalent — the slide
//    overlay renders headline + CTA only — so they intentionally do not migrate.)
//
//   run: railway run node packages/database/scripts/migrate-legacy-hero-to-slide.mjs
//   (DO NOT run against a remote DB without an explicit go-ahead + a fresh backup.)
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const stores = await prisma.store.findMany({
  where: { deletedAt: null },
  select: {
    id: true,
    slug: true,
    heroTitle: true,
    heroTitleAr: true,
    heroCtaText: true,
    heroCtaTextAr: true,
    heroCtaLink: true,
    heroImage: true,
    layoutSettings: true,
  },
});

let seeded = 0;
let skippedHasSlides = 0;
let skippedNoImage = 0;

for (const s of stores) {
  const ls = s.layoutSettings && typeof s.layoutSettings === 'object' ? s.layoutSettings : {};
  const hero = ls.hero && typeof ls.hero === 'object' ? ls.hero : {};
  const existingSlides = Array.isArray(hero.slides) ? hero.slides : [];

  // Idempotent: never touch a store that already has a slide.
  if (existingSlides.length > 0) {
    skippedHasSlides += 1;
    continue;
  }

  // A slide must carry an image. No image → leave the legacy fallback alone.
  if (!s.heroImage) {
    skippedNoImage += 1;
    continue;
  }

  const slide = { image: s.heroImage };
  if (s.heroTitle) slide.headline = s.heroTitle;
  if (s.heroTitleAr) slide.headlineAr = s.heroTitleAr;
  if (s.heroCtaText) slide.ctaText = s.heroCtaText;
  if (s.heroCtaTextAr) slide.ctaTextAr = s.heroCtaTextAr;
  if (s.heroCtaLink) slide.ctaHref = s.heroCtaLink;

  const nextLayout = {
    ...ls,
    hero: {
      ...hero,
      mode: 'single',
      slides: [slide],
    },
  };

  await prisma.store.update({
    where: { id: s.id },
    data: { layoutSettings: nextLayout },
  });
  seeded += 1;
  console.log(`  ✓ ${s.slug}: seeded 1 hero slide from legacy columns`);
}

await prisma.$disconnect();
console.log(
  `\nDone — ${stores.length} stores scanned; seeded ${seeded}, ` +
    `skipped ${skippedHasSlides} (already had slides), ${skippedNoImage} (no hero image).`
);
