/**
 * Demo Store Cloner
 *
 * Clones the live Wady Aljuz store into one demo store per storefront template
 * so clients can compare all templates side by side. Wady Aljuz itself already
 * showcases the `elegant` template, so we only clone the other four:
 *   modern · classic · minimal · bold
 *
 * Each demo:
 *   - copies Wady Aljuz's Store row (theme / layout / typography / settings /
 *     hero / logo / currency …), overriding name + slug + template + domain
 *   - deep-copies categories (with parent remap) + products + product images +
 *     product↔category links
 *   - is owned by the same owner so it shows in the admin store switcher
 *
 * Products are cloned as SIMPLE products (hasVariants=false, variants skipped) —
 * the demos showcase TEMPLATE LAYOUT, not variant flows.
 *
 * Access (no DNS): on any platform domain the storefront resolves a store by
 * the first path segment, so each demo is viewable at `<platform>/demo-<tpl>`.
 *
 * Usage (run against PRODUCTION via Railway so it hits the prod Neon DB):
 *   railway run npx tsx packages/database/prisma/clone-demo-stores.ts
 *   railway run npx tsx packages/database/prisma/clone-demo-stores.ts --cleanup
 *
 * Idempotent: re-running hard-deletes the existing demo-* stores (cascade) and
 * recreates them, so it's safe to run repeatedly.
 */

import { PrismaClient, type StoreTemplate } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Build a demo store's layout: ONLY the source store's CONTENT (hero slides +
 * category copy). Everything else (sizes, frames, columns, shapes, captions,
 * section colors, typography) is left UNSET so the demo INHERITS its template's
 * baseline live via `resolveLayoutSettings(saved, template)`.
 *
 * Why content-only (2026-06-06): if the demo stored the full baseline, later
 * baseline tweaks (e.g. amplified per-template category styling) wouldn't reach
 * the demo without a full catalog reseed. Storing only content lets every
 * future baseline change apply to the demos with zero reseed. The hero MUST
 * still carry real slides — without them the storefront falls through to the
 * deprecated legacy <Hero> (cropped/boxed image in some templates).
 *
 * `template` is unused now but kept for signature stability / future use.
 */
function buildDemoLayout(sourceLayout: unknown, _template: StoreTemplate): Record<string, unknown> {
  const src = (sourceLayout && typeof sourceLayout === 'object' ? sourceLayout : {}) as Record<
    string,
    Record<string, unknown>
  >;
  const srcHero = (src.hero ?? {}) as Record<string, unknown>;
  const srcCats = (src.categories ?? {}) as Record<string, unknown>;
  const layout: Record<string, unknown> = {};
  // Hero content (slides) only — style inherited from the template baseline.
  if (Array.isArray(srcHero.slides) && srcHero.slides.length > 0) {
    layout.hero = { slides: srcHero.slides };
  }
  // Category heading copy only — shape/columns/caption inherited from baseline.
  const catCopy: Record<string, unknown> = {};
  for (const k of ['title', 'titleAr', 'subtitle', 'subtitleAr', 'kicker', 'kickerAr'] as const) {
    if (srcCats[k] != null) catCopy[k] = srcCats[k];
  }
  if (Object.keys(catCopy).length > 0) layout.categories = catCopy;
  return layout;
}

const IS_CLEANUP = process.argv.includes('--cleanup');

const SOURCE_DOMAIN = 'wadyaljuz.com';
const SOURCE_SLUG = 'wadyaljuz';

// The four templates to clone (elegant is already live as Wady Aljuz).
const TEMPLATES: { template: StoreTemplate; label: string; labelAr: string }[] = [
  { template: 'modern', label: 'Modern', labelAr: 'مودرن' },
  { template: 'classic', label: 'Classic', labelAr: 'كلاسيك' },
  { template: 'minimal', label: 'Minimal', labelAr: 'مينيمال' },
  { template: 'bold', label: 'Bold', labelAr: 'بولد' },
];

const demoSlug = (t: StoreTemplate) => `demo-${t}`;
const DEMO_SLUGS = TEMPLATES.map(t => demoSlug(t.template));

async function findSource() {
  const store = await prisma.store.findFirst({
    where: { OR: [{ domain: SOURCE_DOMAIN }, { slug: SOURCE_SLUG }], deletedAt: null },
  });
  if (!store)
    throw new Error(`Source store not found (domain=${SOURCE_DOMAIN} / slug=${SOURCE_SLUG})`);
  return store;
}

async function deleteDemoStores() {
  // Hard delete — cascade removes products / categories / images / links.
  const existing = await prisma.store.findMany({
    where: { slug: { in: DEMO_SLUGS } },
    select: { id: true, slug: true },
  });
  if (existing.length === 0) {
    console.log('No existing demo stores to remove.');
    return;
  }
  for (const s of existing) {
    await prisma.store.delete({ where: { id: s.id } });
    console.log(`  ✗ removed ${s.slug}`);
  }
}

async function cloneInto(
  source: Awaited<ReturnType<typeof findSource>>,
  tpl: (typeof TEMPLATES)[number]
) {
  const slug = demoSlug(tpl.template);

  // Build the new Store row from the source's scalar fields (findFirst returns
  // scalars only — no relations), overriding identity + template.
  const {
    id: _id,
    slug: _slug,
    domain: _domain,
    name: _name,
    nameAr: _nameAr,
    template: _template,
    createdAt: _c,
    updatedAt: _u,
    deletedAt: _d,
    ...scalars
  } = source;

  const newStore = await prisma.store.create({
    data: {
      ...scalars,
      name: `${source.name} — ${tpl.label}`,
      nameAr: source.nameAr
        ? `${source.nameAr} — ${tpl.labelAr}`
        : `${source.name} — ${tpl.labelAr}`,
      slug,
      domain: null, // path-slug access on platform domains; attach a subdomain later if wanted
      template: tpl.template,
      // Brand Engine Phase 2: per-template baseline STYLE + wadyaljuz CONTENT
      // (hero slides + category copy) so each demo shows its template's layout
      // identity AND renders a real full-bleed hero (not the cropped legacy
      // fallback) on real-looking content. Copied `theme` (brand colors) stays,
      // so the Phase-1 engine paints every demo from one palette.
      layoutSettings: buildDemoLayout(source.layoutSettings, tpl.template),
      status: 'active',
    },
  });

  // --- Categories (two passes for parent remap) ---
  const cats = await prisma.category.findMany({
    where: { storeId: source.id, deletedAt: null },
    orderBy: { position: 'asc' },
  });
  const catIdMap = new Map<string, string>();
  for (const c of cats) {
    const { id, storeId, parentId, createdAt, updatedAt, deletedAt, ...crest } = c;
    const nc = await prisma.category.create({ data: { ...crest, storeId: newStore.id } });
    catIdMap.set(id, nc.id);
  }
  for (const c of cats) {
    if (c.parentId && catIdMap.has(c.parentId)) {
      await prisma.category.update({
        where: { id: catIdMap.get(c.id)! },
        data: { parentId: catIdMap.get(c.parentId)! },
      });
    }
  }

  // --- Products (+ images + category links), cloned as simple products ---
  const prods = await prisma.product.findMany({
    where: { storeId: source.id, deletedAt: null },
    include: { images: true, categories: true },
  });
  let productCount = 0;
  for (const p of prods) {
    const {
      id,
      storeId,
      createdAt,
      updatedAt,
      deletedAt,
      images,
      categories,
      hasVariants,
      ...prest
    } = p;
    await prisma.product.create({
      data: {
        ...prest,
        storeId: newStore.id,
        hasVariants: false,
        images: {
          create: images.map(im => ({ url: im.url, alt: im.alt, position: im.position })),
        },
        categories: {
          create: categories
            .filter(pc => catIdMap.has(pc.categoryId))
            .map(pc => ({ categoryId: catIdMap.get(pc.categoryId)! })),
        },
      },
    });
    productCount++;
  }

  console.log(
    `  ✓ ${slug}  (template=${tpl.template})  → ${cats.length} categories, ${productCount} products`
  );
  return newStore;
}

async function main() {
  if (IS_CLEANUP) {
    console.log('Cleaning up demo stores…');
    await deleteDemoStores();
    console.log('Done.');
    return;
  }

  const source = await findSource();
  console.log(`Source: ${source.name} (id=${source.id}, slug=${source.slug})`);

  console.log('Removing any existing demo stores first (idempotent rerun)…');
  await deleteDemoStores();

  console.log(`Cloning into ${TEMPLATES.length} demo stores…`);
  const created = [];
  for (const tpl of TEMPLATES) {
    created.push(await cloneInto(source, tpl));
  }

  console.log('\nDemo stores ready. View each at <platform-domain>/<slug>:');
  for (const s of created) {
    console.log(`  • ${s.slug}  →  /${s.slug}`);
  }
}

main()
  .catch(e => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
