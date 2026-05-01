// Re-upload Palora's product images. The R2 bucket lost every
// `products/<uuid>.jpg` legacy-keyed object for store
// 0bbf478a-efa8-450c-81d9-56898c548b8b at some point — confirmed by
// HEAD-checking each of the 22 ProductImage URLs (all 404) and
// listing the bucket directly. The DB still references the dead
// keys, so the storefront serves broken images on a fresh fetch
// (current-day visitors see them only because of stale browser/PWA
// cache from before the deletion).
//
// This script:
//   1. Loads the 22 active Palora products from the DB
//   2. Maps each product's nameAr to a local file under
//      ~/Downloads/PALORA (chains auto-match by Arabic filename;
//      paintings + kufis need a manual `MANUAL_PAINTING_MAP` /
//      `MANUAL_KUFI_MAP` entry below).
//   3. Reports the matched / unmatched split.
//   4. With `--apply`, uploads each matched file to R2 under
//      `stores/<paloraId>/products/<uuid>.<ext>`, then replaces the
//      stale ProductImage row's url. The legacy 404 url is dropped.
//
// Run from `apps/api/` so `@force/database` and the storage env vars
// resolve.
import 'dotenv/config';
import path from 'path';
import fs from 'fs';
import { promises as fsp } from 'fs';
import os from 'os';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';
import { prisma } from '@force/database';

const STORE_ID = '0bbf478a-efa8-450c-81d9-56898c548b8b';
const SOURCE_ROOT = path.join(os.homedir(), 'Downloads', 'PALORA');
const APPLY = process.argv.includes('--apply');

const ENDPOINT = process.env.STORAGE_ENDPOINT;
const ACCESS_KEY = process.env.STORAGE_ACCESS_KEY;
const SECRET_KEY = process.env.STORAGE_SECRET_KEY;
const BUCKET = process.env.STORAGE_BUCKET;
const PUBLIC_URL = process.env.STORAGE_PUBLIC_URL;

if (!ENDPOINT || !ACCESS_KEY || !SECRET_KEY || !BUCKET || !PUBLIC_URL) {
  console.error('Missing STORAGE_* env vars. Run from apps/api/ with .env loaded.');
  process.exit(1);
}

// Manual mappings for products whose images can't be matched by name
// (the local zip uses generic IMG_xxxx filenames). Update these and
// re-run if the user provides a mapping.
const MANUAL_PAINTING_MAP = {
  // 'product nameAr exactly': 'absolute path to png/jpg',
};
const MANUAL_KUFI_MAP = {
  // 'كوفية 1': '/Users/.../kufi-1.jpg',
};

const ARABIC_DIACRITICS = /[ً-ْٰـ]/g; // strip tashkeel + tatweel
function normalize(s) {
  return s
    .toLowerCase()
    .trim()
    .replace(ARABIC_DIACRITICS, '')
    .replace(/[إأآا]/g, 'ا') // alef variants
    .replace(/[ى]/g, 'ي')
    .replace(/[ة]/g, 'ه')
    .replace(/[\s\-_().]/g, '')
    .replace(/[\d٠-٩]/g, '');
}
function arabicTokens(s) {
  return new Set(
    s
      .replace(ARABIC_DIACRITICS, '')
      .replace(/[إأآا]/g, 'ا')
      .replace(/[ى]/g, 'ي')
      .replace(/[ة]/g, 'ه')
      .split(/[\s\-_(),.]+/)
      .filter(t => t && !/^\d+$/.test(t) && t.length > 1)
  );
}

async function listFiles(root) {
  const out = [];
  async function walk(dir) {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__MACOSX') continue;
        await walk(p);
      } else if (/\.(jpe?g|png|webp)$/i.test(entry.name) && !entry.name.startsWith('._')) {
        out.push(p);
      }
    }
  }
  await walk(root);
  return out;
}

const palora = await prisma.store.findUnique({
  where: { id: STORE_ID },
  select: { id: true, slug: true, name: true },
});
if (!palora) {
  console.error('Palora store not found.');
  process.exit(1);
}

const products = await prisma.product.findMany({
  where: { storeId: STORE_ID, deletedAt: null },
  select: {
    id: true,
    name: true,
    nameAr: true,
    sku: true,
    images: { select: { id: true, url: true }, orderBy: { position: 'asc' } },
  },
});

const localFiles = await listFiles(SOURCE_ROOT);
console.log(`Palora: ${products.length} products, ${localFiles.length} local images.\n`);

// Score each (product, file) pair by token overlap on the Arabic name
// vs the filename basename. Keeps the script tolerant of trailing
// material qualifiers ("- ستانليس ستيل", "- نحاس") that aren't in the
// filename, and of trailing whitespace/typos in the source files.
const matches = []; // { product, file, score }
const used = new Set();
for (const p of products) {
  const productTokens = arabicTokens(p.nameAr || p.name || '');
  let best = null;
  for (const file of localFiles) {
    if (used.has(file)) continue;
    const baseTokens = arabicTokens(path.basename(file, path.extname(file)));
    let overlap = 0;
    for (const t of baseTokens) if (productTokens.has(t)) overlap++;
    // Require at least 2 token overlap to count it as a match (avoids
    // matching every chain on the شنسال/سنسال token alone).
    if (overlap >= 2 && (!best || overlap > best.overlap)) {
      best = { file, overlap };
    }
  }
  if (best) {
    matches.push({ product: p, file: best.file, score: best.overlap, source: 'auto' });
    used.add(best.file);
  }
}

// Layer in manual overrides (paintings + kufis).
for (const [nameAr, file] of Object.entries({ ...MANUAL_PAINTING_MAP, ...MANUAL_KUFI_MAP })) {
  const product = products.find(p => p.nameAr === nameAr);
  if (!product) {
    console.warn(`Manual map: no product matches '${nameAr}'`);
    continue;
  }
  if (!fs.existsSync(file)) {
    console.warn(`Manual map: file not found '${file}'`);
    continue;
  }
  const existing = matches.find(m => m.product.id === product.id);
  if (existing) {
    existing.file = file;
    existing.source = 'manual';
  } else {
    matches.push({ product, file, score: 99, source: 'manual' });
  }
  used.add(file);
}

const unmatched = products.filter(p => !matches.find(m => m.product.id === p.id));
const unusedFiles = localFiles.filter(f => !used.has(f));

console.log(`MATCHED (${matches.length}/${products.length}):`);
for (const m of matches.sort((a, b) => a.product.nameAr.localeCompare(b.product.nameAr))) {
  console.log(`  ${m.source === 'manual' ? '[manual]' : '[auto]  '} ${m.product.nameAr}`);
  console.log(`           -> ${path.relative(SOURCE_ROOT, m.file)}`);
}
console.log(`\nUNMATCHED PRODUCTS (${unmatched.length}):`);
for (const p of unmatched) console.log(`  ${p.id}  ${p.nameAr}`);
console.log(`\nUNUSED LOCAL FILES (${unusedFiles.length}):`);
for (const f of unusedFiles) console.log(`  ${path.relative(SOURCE_ROOT, f)}`);

if (!APPLY) {
  console.log('\nDRY RUN — pass --apply to upload to R2 and rewrite ProductImage rows.');
  console.log(
    'Add MANUAL_PAINTING_MAP / MANUAL_KUFI_MAP entries above for unmatched products before applying.'
  );
  await prisma.$disconnect();
  process.exit(0);
}

const s3 = new S3Client({
  endpoint: ENDPOINT,
  region: 'auto',
  credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
  forcePathStyle: true,
});
const mimeFor = ext => {
  switch (ext.toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    case '.webp':
      return 'image/webp';
    default:
      return 'application/octet-stream';
  }
};

let uploaded = 0;
for (const m of matches) {
  const ext = path.extname(m.file).toLowerCase();
  const buffer = await fsp.readFile(m.file);
  const objectId = randomUUID();
  // New per-store key shape — consistent with how Wady Aljuz's images
  // are keyed today (see scripts/r2-orphan-audit.ts for the convention).
  const key = `stores/${STORE_ID}/products/${objectId}${ext}`;
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: buffer,
      ContentType: mimeFor(ext),
      CacheControl: 'public, max-age=31536000, immutable',
    })
  );
  const newUrl = `${PUBLIC_URL}/${key}`;
  // Replace the existing image row (if any) so we don't end up with
  // two rows where one is dead and one is alive — the storefront
  // would still occasionally render the dead one.
  if (m.product.images[0]) {
    await prisma.productImage.update({
      where: { id: m.product.images[0].id },
      data: { url: newUrl },
    });
  } else {
    await prisma.productImage.create({
      data: { productId: m.product.id, url: newUrl, position: 0 },
    });
  }
  uploaded++;
  console.log(`✓ ${m.product.nameAr} -> ${newUrl}`);
}

console.log(`\nUploaded ${uploaded} images. Unmatched products still need manual mapping.`);
await prisma.$disconnect();
