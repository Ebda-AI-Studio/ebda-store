#!/usr/bin/env node
// Local-only seed for scripts/visual/measure-card-overflow.mjs: one store per skin
// (fu-modern|elegant|classic|minimal|bold|dahab), each with a 64-char Arabic and an
// long English product name whose first word is 40 unbroken characters so card/PDP overflow is reproducible.
//   DATABASE_URL=<owner-role url on localhost> node scripts/visual/seed-card-overflow.mjs   (repo root)
// Refuses any non-localhost DATABASE_URL. Idempotent: upserts on natural keys; the Linen Abaya's
// options/variants are rebuilt each run..
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const req = createRequire(join(root, 'package.json'));
const { parse } = req('pg-connection-string');
const bcrypt = req('bcryptjs');

const url = process.env.DATABASE_URL;
const host = (() => {
  try {
    new URL(url);
    return String(parse(url).host ?? '').toLowerCase();
  } catch {
    return null;
  }
})();
if (
  !host ||
  !['localhost', '127.0.0.1', '::1'].includes(host) ||
  new URL(url).searchParams.has('host')
) {
  console.error(`Refusing: DATABASE_URL host "${host}" is not localhost.`);
  process.exit(2);
}
process.env.DIRECT_URL ??= url;

const OWNER_EMAIL = 'fu-owner@example.test';
// The owner only has to exist (the storefront is public); the password is random and never stored.
const password = crypto.randomBytes(12).toString('base64url') + 'aA1!';

// Self-contained placeholder art (data: URIs - no network, no R2). Next/Image skips the loader for data:.
const art = (label, c1, c2) =>
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1000" viewBox="0 0 800 1000"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs><rect width="800" height="1000" fill="url(#g)"/><circle cx="400" cy="430" r="150" fill="rgba(255,255,255,.22)"/><text x="400" y="780" font-family="sans-serif" font-size="44" text-anchor="middle" fill="#fff">${label}</text></svg>`
  );
const swatchArt = art('', '#7a5c3a', '#c9a96e');

const CAT = { slug: 'abayas', name: 'Abayas', nameAr: 'عبايات' };
const STORES = ['qamar', 'souq', 'jasmine', 'lamma', 'dahab'].map(t => ({
  slug: 'fu-' + t,
  template: t,
  name: 'FU ' + t,
  nameAr: 'متجر ' + t,
  cat: CAT,
}));
const LONG_AR = 'عباية كتان مطرزة يدوياً بخيوط الحرير الطبيعي إصدار السهرة الفاخر';
const LONG_EN = 'Handembroideredlinenkaftanwithsilkpiping Evening Edition Extra Long Name';
const FILLER = [
  ['long-ar', LONG_AR, LONG_AR, 149000, '#6b8f71', '#2f4f4f'],
  ['long-en', LONG_EN, LONG_EN, 149000, '#c98b8b', '#7a3e48'],
  ['cotton-kaftan', 'Cotton kaftan', 'قفطان قطن', 129000, '#6b8f71', '#2f4f4f'],
  ['silk-scarf', 'Silk scarf', 'وشاح حرير', 64000, '#c98b8b', '#7a3e48'],
  ['wool-shawl', 'Wool shawl', 'شال صوف', 89000, '#8a7f72', '#3b342c'],
  ['linen-trousers', 'Linen trousers', 'بنطلون كتان', 99000, '#b5a58a', '#5a4e3a'],
  ['embroidered-dress', 'Embroidered dress', 'فستان مطرز', 189000, '#1f4e54', '#0b2427'],
];
const COLOURS = [
  ['Teal', 'أزرق مخضر', '#1F4E54', null],
  ['Rose', 'وردي', '#C98B8B', swatchArt],
  ['Black', 'أسود', '#141414', null],
];
const SIZES = ['S', 'M', 'L'];
const LENGTHS = ['52', '54', '56'];

const { createPrismaClient } = await import(pathToRel(root, '@ebda/database'));
function pathToRel(r, spec) {
  return req.resolve(spec).startsWith('/') ? 'file://' + req.resolve(spec) : spec;
}

const prisma = createPrismaClient({ connectionString: url, role: 'owner' });
try {
  const passwordHash = await bcrypt.hash(password, 10);
  for (const s of STORES) {
    await prisma.$transaction(async tx => {
      let owner = await tx.user.findFirst({ where: { email: OWNER_EMAIL, storeId: null } });
      owner = owner
        ? await tx.user.update({
            where: { id: owner.id },
            data: { passwordHash, emailVerified: true, status: 'active' },
          })
        : await tx.user.create({
            data: {
              email: OWNER_EMAIL,
              passwordHash,
              firstName: 'B0',
              lastName: 'Owner',
              role: 'store_admin',
              emailVerified: true,
              language: 'ar',
            },
          });
      const base = {
        name: s.name,
        nameAr: s.nameAr,
        template: s.template,
        theme: {},
        status: 'active',
        currency: 'EGP',
        settings: { defaultLanguage: 'ar' },
      };
      const store = await tx.store.upsert({
        where: { slug: s.slug },
        update: base,
        create: { ...base, slug: s.slug, ownerId: owner.id },
      });
      const cat = await tx.category.upsert({
        where: { storeId_slug: { storeId: store.id, slug: s.cat.slug } },
        update: { name: s.cat.name, nameAr: s.cat.nameAr },
        create: { storeId: store.id, ...s.cat, position: 0 },
      });

      const products = [
        {
          slug: 'linen-abaya',
          name: 'Linen Abaya',
          nameAr: 'عباية كتان',
          price: 149000,
          c1: '#1F4E54',
          c2: '#0b2427',
          description: 'Breathable linen abaya with a relaxed drape.',
          descriptionAr: 'عباية كتان مريحة بقصة واسعة.',
        },
        ...FILLER.map(([slug, name, nameAr, price, c1, c2]) => ({
          slug,
          name,
          nameAr,
          price,
          c1,
          c2,
        })),
      ];
      for (const [i, p] of products.entries()) {
        const data = {
          name: p.name,
          nameAr: p.nameAr,
          price: p.price,
          status: 'active',
          featured: i < 3,
          isNew: i < 3,
          description: p.description ?? `${p.name} - local design-review sample.`,
          descriptionAr: p.descriptionAr ?? `${p.nameAr} - عينة للمراجعة.`,
        };
        const product = await tx.product.upsert({
          where: { storeId_slug: { storeId: store.id, slug: p.slug } },
          update: data,
          create: { storeId: store.id, slug: p.slug, inventory: 50, ...data },
        });
        await tx.productImage.deleteMany({ where: { productId: product.id } });
        await tx.productImage.createMany({
          data: [0, 1].map(n => ({
            productId: product.id,
            url: art(p.name + (n ? ' 2' : ''), n ? p.c2 : p.c1, n ? p.c1 : p.c2),
            alt: p.name,
            position: n,
          })),
        });
        await tx.productCategory.upsert({
          where: { productId_categoryId: { productId: product.id, categoryId: cat.id } },
          update: { position: i },
          create: { productId: product.id, categoryId: cat.id, position: i },
        });

        if (p.slug === 'linen-abaya') {
          await tx.productVariant.deleteMany({ where: { productId: product.id } });
          await tx.productOption.deleteMany({ where: { productId: product.id } });
          const mk = async (name, nameAr, position, vals) => {
            const opt = await tx.productOption.create({
              data: { productId: product.id, name, nameAr, position },
            });
            const out = [];
            for (const [j, v] of vals.entries())
              out.push(
                await tx.productOptionValue.create({
                  data: {
                    optionId: opt.id,
                    value: v.value,
                    valueAr: v.valueAr,
                    swatchHex: v.hex ?? null,
                    swatchImageUrl: v.img ?? null,
                    position: j,
                  },
                })
              );
            return out;
          };
          const colour = await mk(
            'Colour',
            'اللون',
            0,
            COLOURS.map(([value, valueAr, hex, img]) => ({ value, valueAr, hex, img }))
          );
          const size = await mk(
            'Size',
            'المقاس',
            1,
            SIZES.map(v => ({ value: v, valueAr: v }))
          );
          const length = await mk(
            'Length',
            'الطول',
            2,
            LENGTHS.map(v => ({ value: v, valueAr: v + ' سم' }))
          );
          let pos = 0,
            total = 0;
          for (const c of colour)
            for (const z of size)
              for (const l of length) {
                const soldOut = c.value === 'Teal' && z.value === 'M' && l.value === '56';
                const inv = soldOut ? 0 : 10;
                total += inv;
                const v = await tx.productVariant.create({
                  data: {
                    productId: product.id,
                    title: `${c.value} / ${z.value} / ${l.value}`,
                    titleAr: `${c.valueAr} / ${z.valueAr} / ${l.valueAr}`,
                    sku: `LA-${c.value[0]}${z.value}${l.value}`,
                    inventory: inv,
                    position: pos++,
                    imageUrl:
                      c.value === 'Rose' && z.value === 'S' && l.value === '52'
                        ? art('Rose variant', '#C98B8B', '#7a3e48')
                        : null,
                  },
                });
                await tx.productVariantOption.createMany({
                  data: [c, z, l].map(o => ({ variantId: v.id, valueId: o.id })),
                });
              }
          await tx.product.update({ where: { id: product.id }, data: { inventory: total } });
        }
      }

      const zone = await tx.shippingZone.findFirst({
        where: { storeId: store.id, name: 'Greater Cairo' },
      });
      const zdata = {
        nameAr: 'القاهرة الكبرى',
        areas: ['Cairo', 'Giza'],
        areasAr: ['القاهرة', 'الجيزة'],
        deliveryFee: 5000,
        estimatedDays: 2,
        estimatedDaysMin: 1,
        estimatedDaysMax: 3,
        isActive: true,
      };
      if (zone) await tx.shippingZone.update({ where: { id: zone.id }, data: zdata });
      else
        await tx.shippingZone.create({
          data: { storeId: store.id, name: 'Greater Cairo', ...zdata },
        });
      console.log(`seeded ${s.slug} (${store.id}) template=${s.template}`);
    });
  }
} finally {
  await prisma.$disconnect();
}
