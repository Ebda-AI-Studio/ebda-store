// One-shot maintenance script — downscale a store's hero slide images
// to the canonical sizes defined in design.md + packages/shared/src/types/
// image-standards.ts:
//
//   desktop:  1920 × 700   (≈2.74:1)
//   mobile:   800  × 1067  (3:4 portrait)
//
// Why this exists: merchants sometimes upload raw photos at 4K-8K width
// without realizing the storefront will only ever render at ~1920px max.
// Wady Aljuz's hero is currently 7986×3327 / 10 MB — Next/Image still
// downsamples on serve, but the 10 MB original sits in R2 forever and
// every WebP-conversion pass loads the full file into memory. Downscaling
// at the source keeps R2 lean + speeds up the AVIF/WebP pipeline.
//
// What the script does for the given store slug:
//   1. Loads layout_settings.hero.slides from the DB.
//   2. For each slide and each of image / imageAr (desktop) +
//      imageMobile / imageMobileAr (mobile when present):
//        a. HEAD the URL — skip files already < SKIP_BYTES (default 250KB).
//        b. Download the original.
//        c. Pass through sharp:
//             desktop variants → resize to 1920×700, cover fit, WebP q80
//             mobile variants  → resize to 800×1067, cover fit, WebP q80
//        d. Upload the new WebP to R2 under
//             stores/<storeId>/hero/<new-uuid>.webp
//        e. Stage the old URL for deletion + the new URL for the DB update.
//   3. With --apply: write the new URLs into layout_settings, then delete
//      the staged-old R2 objects (R2-cleanup discipline — same pattern as
//      cleanupRemovedImages).
//   4. Default = dry-run: print plan, no DB write, no R2 mutation.
//
// Mobile auto-generation policy: this script does NOT generate a mobile
// crop FROM the desktop image when the merchant hasn't uploaded one.
// Cover-cropping a 1920×700 landscape into 800×1067 portrait produces a
// thin vertical sliver from the center of the original, which usually
// looks awful. If the merchant uploaded a dedicated mobile image, we
// downscale that. Otherwise we leave the slide alone (the storefront's
// HeroBanner already falls back to a 3:2 mobile aspect when no dedicated
// mobile source exists).
//
// Run from apps/api/ so prisma + dotenv + storage env vars resolve.

import 'dotenv/config';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';
import sharp from 'sharp';
import { prisma } from '@force/database';

const SLUG = process.argv[2];
const APPLY = process.argv.includes('--apply');
const SKIP_BYTES = 250 * 1024; // already small enough — skip

if (!SLUG || SLUG.startsWith('--')) {
  console.error('usage: node scripts/downscale-oversized-hero.mjs <store-slug> [--apply]');
  process.exit(1);
}

const ENDPOINT = process.env.STORAGE_ENDPOINT;
const ACCESS_KEY = process.env.STORAGE_ACCESS_KEY;
const SECRET_KEY = process.env.STORAGE_SECRET_KEY;
const BUCKET = process.env.STORAGE_BUCKET;
const PUBLIC_URL = process.env.STORAGE_PUBLIC_URL;

if (!ENDPOINT || !ACCESS_KEY || !SECRET_KEY || !BUCKET || !PUBLIC_URL) {
  console.error('Missing STORAGE_* env vars. Run from apps/api/ with .env loaded.');
  process.exit(1);
}

const s3 = new S3Client({
  endpoint: ENDPOINT,
  region: 'auto',
  credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
  forcePathStyle: true,
});

const DESKTOP = { w: 1920, h: 700, label: 'desktop' };
const MOBILE = { w: 800, h: 1067, label: 'mobile' };

/** Extract the R2 object key from a full PUBLIC_URL — for the delete-old step. */
function keyFromUrl(url) {
  if (!url) return null;
  const prefix = PUBLIC_URL.endsWith('/') ? PUBLIC_URL : PUBLIC_URL + '/';
  if (!url.startsWith(prefix)) return null;
  return url.slice(prefix.length);
}

async function downscaleOne(url, target, storeId) {
  // HEAD the source first so we can skip small files without downloading.
  let head;
  try {
    head = await fetch(url, { method: 'HEAD' });
  } catch (e) {
    return { skip: true, reason: `HEAD failed: ${e.message}`, url };
  }
  if (!head.ok) {
    return { skip: true, reason: `HEAD ${head.status}`, url };
  }
  const bytes = Number(head.headers.get('content-length') || '0');
  if (bytes > 0 && bytes < SKIP_BYTES) {
    return {
      skip: true,
      reason: `already < ${(SKIP_BYTES / 1024).toFixed(0)}KB (${(bytes / 1024).toFixed(0)}KB)`,
      url,
    };
  }

  // Download + downscale.
  const res = await fetch(url);
  if (!res.ok) return { skip: true, reason: `GET ${res.status}`, url };
  const inputBuf = Buffer.from(await res.arrayBuffer());
  const inputMeta = await sharp(inputBuf).metadata();
  const outputBuf = await sharp(inputBuf)
    .resize(target.w, target.h, { fit: 'cover', position: 'center' })
    .webp({ quality: 80 })
    .toBuffer();

  return {
    skip: false,
    url,
    inputW: inputMeta.width,
    inputH: inputMeta.height,
    inputBytes: inputBuf.length,
    outputBytes: outputBuf.length,
    outputBuf,
    newKey: `stores/${storeId}/hero/${randomUUID()}.webp`,
    target,
  };
}

async function main() {
  const store = await prisma.store.findUnique({
    where: { slug: SLUG },
    select: { id: true, slug: true, name: true, layoutSettings: true },
  });
  if (!store) {
    console.error(`Store not found: ${SLUG}`);
    process.exit(1);
  }
  console.log(`Store: ${store.name} (${store.slug}) ${store.id}`);

  const layout = store.layoutSettings || {};
  const slides = (layout?.hero?.slides ?? []).slice();
  if (slides.length === 0) {
    console.log('No hero slides — nothing to do.');
    await prisma.$disconnect();
    return;
  }
  console.log(`${slides.length} hero slide(s).`);

  // Gather work + execute downscale in memory. The replacement map keeps
  // track of (slideIndex, field) → newUrl so we can patch the JSON in one
  // shot at the end.
  const replacements = [];
  const oldKeysToDelete = [];

  for (let i = 0; i < slides.length; i++) {
    const slide = slides[i];
    for (const [field, target] of [
      ['image', DESKTOP],
      ['imageAr', DESKTOP],
      ['imageMobile', MOBILE],
      ['imageMobileAr', MOBILE],
    ]) {
      const url = slide[field];
      if (!url) continue;
      const r = await downscaleOne(url, target, store.id);
      if (r.skip) {
        console.log(`  slide[${i}].${field}: SKIP — ${r.reason}`);
        continue;
      }
      const compressed = ((1 - r.outputBytes / r.inputBytes) * 100).toFixed(0);
      console.log(
        `  slide[${i}].${field}: ${r.inputW}×${r.inputH} (${(r.inputBytes / 1024).toFixed(0)}KB) → ${target.w}×${target.h} (${(r.outputBytes / 1024).toFixed(0)}KB, -${compressed}%)`
      );
      replacements.push({
        slideIndex: i,
        field,
        oldUrl: url,
        newUrl: `${PUBLIC_URL}/${r.newKey}`,
        newKey: r.newKey,
        outputBuf: r.outputBuf,
      });
      const oldKey = keyFromUrl(url);
      if (oldKey) oldKeysToDelete.push(oldKey);
    }
  }

  if (replacements.length === 0) {
    console.log('\nNo changes — everything already within size budget.');
    await prisma.$disconnect();
    return;
  }

  console.log(`\n${replacements.length} replacement(s) staged.`);

  if (!APPLY) {
    console.log(
      '\nDRY-RUN. Pass --apply to upload + rewrite layout_settings + delete old R2 keys.'
    );
    await prisma.$disconnect();
    return;
  }

  // 1) Upload all new objects to R2.
  for (const r of replacements) {
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: r.newKey,
        Body: r.outputBuf,
        ContentType: 'image/webp',
        CacheControl: 'public, max-age=31536000, immutable',
      })
    );
    console.log(`  uploaded ${r.newKey}`);
  }

  // 2) Patch layout_settings JSON. Build a new slides array with the URLs swapped.
  const nextSlides = slides.map((s, i) => {
    const next = { ...s };
    for (const r of replacements) {
      if (r.slideIndex !== i) continue;
      next[r.field] = r.newUrl;
    }
    return next;
  });
  const nextLayout = {
    ...layout,
    hero: { ...(layout?.hero ?? {}), slides: nextSlides },
  };
  await prisma.store.update({
    where: { id: store.id },
    data: { layoutSettings: nextLayout },
  });
  console.log('  layout_settings updated.');

  // 3) Delete the old R2 keys (only after the DB write succeeds so we
  //    don't leave orphaned references). Compensating-rollback discipline:
  //    if any delete fails, log it; the new URLs are already live so
  //    the old keys become true orphans and r2-orphan-audit.ts will
  //    surface them on the next run.
  for (const key of oldKeysToDelete) {
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
      console.log(`  deleted old ${key}`);
    } catch (e) {
      console.warn(`  ⚠ delete failed ${key}: ${e.message} (will surface in r2-orphan-audit)`);
    }
  }

  console.log('\nDone.');
  await prisma.$disconnect();
}

main().catch(async e => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
