// Convert demo stores' layoutSettings to CONTENT-ONLY (hero slides + category
// copy), so they inherit their template's baseline STYLE live via
// resolveLayoutSettings(saved, template). Lightweight — rewrites only the
// layoutSettings JSON on the 4 demo rows; does NOT touch the catalog (no
// reseed). Idempotent. After this, future baseline changes reach the demos
// with no reseed.
//   run: railway run node packages/database/scripts/demos-content-only-layout.mjs
import { createPrismaClient } from '@force/database';
const prisma = createPrismaClient({ connectionString: process.env.DATABASE_URL ?? '', role: 'owner' });

const demos = await prisma.store.findMany({
  where: { slug: { startsWith: 'demo-' } },
  select: { id: true, slug: true, layoutSettings: true },
});

for (const d of demos) {
  const ls = d.layoutSettings && typeof d.layoutSettings === 'object' ? d.layoutSettings : {};
  const hero = ls.hero ?? {};
  const cats = ls.categories ?? {};
  const next = {};
  if (Array.isArray(hero.slides) && hero.slides.length > 0) next.hero = { slides: hero.slides };
  const copy = {};
  for (const k of ['title', 'titleAr', 'subtitle', 'subtitleAr', 'kicker', 'kickerAr']) {
    if (cats[k] != null) copy[k] = cats[k];
  }
  if (Object.keys(copy).length > 0) next.categories = copy;

  await prisma.store.update({ where: { id: d.id }, data: { layoutSettings: next } });
  console.log(
    `  ✓ ${d.slug}: layout → content-only (hero.slides=${next.hero?.slides?.length ?? 0}, catCopy=${Object.keys(copy).length})`
  );
}
await prisma.$disconnect();
console.log(`\nDone — ${demos.length} demos now inherit their template baseline live.`);
