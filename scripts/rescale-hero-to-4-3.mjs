// One-shot: rescale a store's mobile hero images from the legacy
// 1920/700 (≈2.74:1) billboard aspect into the new 4:3 mobile container
// (1080×810) using a blurred letterbox extension.
//
// Background: the storefront HeroBanner mobile container moved from
// aspect-[1920/700] (142px tall on a 390px phone — too small) to
// aspect-[4/3] (292px tall — proper hero size, ~37% viewport). Merchant
// sources are still uploaded at the legacy billboard aspect; without
// rescale they'd either get heavy side-crop (~51%) or center small with
// padding. This script extends each mobile source into a 4:3 frame:
// the original image renders uncropped centered, with a blurred copy
// of itself filling the top + bottom bands.
//
// What it does for the given slug:
//   1. Load layout_settings.hero.slides from the DB.
//   2. For each slide's imageMobile + imageMobileAr:
//      a. Download the original from R2.
//      b. Build a 4:3 canvas (e.g. 1080×810) with a heavily-blurred
//         copy of the source scaled to fully cover, then composite the
//         original centered on top.
//      c. Encode as WebP q80, upload to R2 under
//         stores/<storeId>/hero/<new-uuid>-4-3.webp.
//      d. Stage the old URL for deletion.
//   3. With --apply: write new URLs to layout_settings, delete staged
//      old R2 objects.
//   4. Default = dry-run.
//
// Run from apps/api/ so prisma + dotenv + storage env vars resolve.

import 'dotenv/config';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';
import sharp from 'sharp';
import { prisma } from '@force/database';

const SLUG = process.argv[2];
const APPLY = process.argv.includes('--apply');

if (!SLUG || SLUG.startsWith('--')) {
  console.error('usage: node scripts/rescale-hero-to-4-3.mjs <store-slug> [--apply]');
  process.exit(1);
}

const ENDPOINT = process.env.STORAGE_ENDPOINT;
const ACCESS_KEY = process.env.STORAGE_ACCESS_KEY;
const SECRET_KEY = process.env.STORAGE_SECRET_KEY;
const BUCKET = process.env.STORAGE_BUCKET;
const PUBLIC_BASE = process.env.STORAGE_PUBLIC_URL;

if (!ENDPOINT || !ACCESS_KEY || !SECRET_KEY || !BUCKET || !PUBLIC_BASE) {
  console.error('missing STORAGE_* env vars. run from apps/api/.');
  process.exit(1);
}

const s3 = new S3Client({
  endpoint: ENDPOINT,
  region: 'auto',
  credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
});

// Target 4:3 mobile canvas. 1080×810 keeps file under ~250KB at q80
// and still serves crisp at 3x DPR (360 logical px × 3 = 1080).
const TARGET_W = 1080;
const TARGET_H = 810;
const BLUR_SIGMA = 30;
const WEBP_QUALITY = 80;

function r2KeyFromUrl(url) {
  // PUBLIC_BASE is like 'https://pub-xxx.r2.dev'. Strip + leading slash.
  return url.replace(PUBLIC_BASE, '').replace(/^\//, '');
}

async function transformOne(url, storeId) {
  console.log(`  fetching ${url.slice(-60)}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} -> ${res.status}`);
  const srcBuf = Buffer.from(await res.arrayBuffer());

  const meta = await sharp(srcBuf).metadata();
  console.log(`  source ${meta.width}x${meta.height} (${(meta.width / meta.height).toFixed(2)}:1)`);

  // Step 1: normalize source to TARGET_W wide, keep aspect.
  const fitWidth = await sharp(srcBuf)
    .resize({ width: TARGET_W, withoutEnlargement: false })
    .toBuffer();
  const fitMeta = await sharp(fitWidth).metadata();
  const fitH = fitMeta.height;
  console.log(`  fit-to-width ${fitMeta.width}x${fitH}`);

  // Step 2: blurred background — cover the 4:3 canvas using the source,
  // then heavy blur. Acts as the letterbox bg.
  const bgBuf = await sharp(srcBuf)
    .resize(TARGET_W, TARGET_H, { fit: 'cover' })
    .blur(BLUR_SIGMA)
    .toBuffer();

  // Step 3: composite the fit-width source on top of the bg, centered.
  const topOffset = Math.max(0, Math.round((TARGET_H - fitH) / 2));
  const outBuf = await sharp(bgBuf)
    .composite([{ input: fitWidth, top: topOffset, left: 0 }])
    .webp({ quality: WEBP_QUALITY })
    .toBuffer();

  console.log(`  output ${TARGET_W}x${TARGET_H} webp (${(outBuf.length / 1024).toFixed(0)} KB)`);

  const key = `stores/${storeId}/hero/${randomUUID()}-4-3.webp`;
  if (APPLY) {
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: outBuf,
        ContentType: 'image/webp',
        CacheControl: 'public, max-age=31536000, immutable',
      })
    );
    console.log(`  uploaded ${key}`);
  } else {
    console.log(`  [dry-run] would upload ${key}`);
  }

  return { newUrl: `${PUBLIC_BASE}/${key}`, oldKey: r2KeyFromUrl(url) };
}

(async () => {
  const store = await prisma.store.findFirst({
    where: { slug: SLUG },
    select: { id: true, layoutSettings: true },
  });
  if (!store) {
    console.error(`store ${SLUG} not found`);
    process.exit(1);
  }

  const layout = store.layoutSettings || {};
  const hero = layout.hero || {};
  const slides = hero.slides || [];
  if (slides.length === 0) {
    console.log('no slides — nothing to rescale');
    process.exit(0);
  }

  const staged = [];
  for (let i = 0; i < slides.length; i++) {
    const slide = slides[i];
    console.log(`\nslide ${i + 1}/${slides.length}`);
    for (const field of ['imageMobile', 'imageMobileAr']) {
      const url = slide[field];
      if (!url) continue;
      console.log(` ${field}:`);
      try {
        const { newUrl, oldKey } = await transformOne(url, store.id);
        staged.push({ slideIdx: i, field, oldKey, newUrl });
      } catch (err) {
        console.error(`  ERROR: ${err.message}`);
      }
    }
  }

  if (!APPLY) {
    console.log(`\n[dry-run] ${staged.length} images would be rescaled. add --apply to write.`);
    process.exit(0);
  }

  // Write new URLs into layout_settings
  const nextSlides = slides.map((s, i) => {
    const updates = staged.filter(x => x.slideIdx === i);
    const next = { ...s };
    for (const u of updates) next[u.field] = u.newUrl;
    return next;
  });
  const nextLayout = { ...layout, hero: { ...hero, slides: nextSlides } };
  await prisma.store.update({
    where: { id: store.id },
    data: { layoutSettings: nextLayout },
  });
  console.log(`\nDB updated for ${SLUG}`);

  // Delete old objects (best-effort)
  for (const u of staged) {
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: u.oldKey }));
      console.log(`  deleted ${u.oldKey}`);
    } catch (err) {
      console.warn(`  failed to delete ${u.oldKey}: ${err.message}`);
    }
  }
  console.log('done.');
  process.exit(0);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
