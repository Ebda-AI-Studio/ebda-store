/**
 * Backfill the full PWA icon set (icon192/384/512, iconAppleTouch, favicon32/16, maskableIcon and
 * iconSource) for stores created before the generator existed.
 *
 * docs/superpowers/plans/2026-05-04-storefront-per-store-pwa-full-sizes.md, task 7.
 *
 * - DRY RUN by default: it fetches and validates each store's source and prints what it WOULD do.
 *   Nothing is uploaded or written without `--apply`.
 * - IDEMPOTENT: a store whose pwaSettings already carry every icon key is skipped, and the
 *   settings are re-read just before the write so a merchant who finished their own upload while
 *   a store was generating is never overwritten.
 * - RESUMABLE: stores are walked in id order in batches; `--after <storeId>` continues from a
 *   previous run (the run prints the exact line) and `--limit <n>` bounds one run. A re-run after
 *   a crash simply skips the stores that are already complete.
 * - Skips a store with no source at all (no iconSource / icon512 / icon192 / logo), a logo that is
 *   not an image or is under 256px, and any non-https or private-host source URL.
 * - Source = iconSource, else icon512, else icon192, else the store logo. A square PNG >= 512px
 *   is used as is; any other raster/SVG logo is centred on a transparent square PNG (>= 512px).
 *
 * Resizing here is `sharp` (this script runs in Node). generatePwaIconSet normally resizes through
 * the Workers-only Cloudflare Images binding; without it, it would store the 512px source under the
 * 16px favicon key and page us, so the script injects its own `resizer` (same geometry as
 * lib/images/icon-resizer.ts: the maskable art in the central 80%, padded with the store's PWA
 * background, opaque).
 *
 * RUN (never from an agent; Ahmad runs it). Needs the prod DATABASE_URL (read-write) and the R2
 * storage env the API uses (see docs/ENVIRONMENT.md: STORAGE_*), exported in the shell:
 *
 *   npx tsx scripts/backfill-store-pwa-icons.ts                         # dry run, every store
 *   npx tsx scripts/backfill-store-pwa-icons.ts --store <id|slug>       # dry run, one store
 *   npx tsx scripts/backfill-store-pwa-icons.ts --apply --store <id|slug>   # one store for real
 *   npx tsx scripts/backfill-store-pwa-icons.ts --apply --limit 25      # next 25 incomplete stores
 *   npx tsx scripts/backfill-store-pwa-icons.ts --apply --after <storeId>   # resume
 *
 * `stores` carries no RLS policy, so the walk reads it with the plain client like
 * backfill-slug-redirects.ts; the write goes through PWAService.updateSettings (tenant context).
 */
import { fileURLToPath } from 'url';
import sharp from 'sharp';
import { prisma } from '@ebda/database';
import {
  generatePwaIconSet,
  PWAService,
  type GeneratedPwaIcons,
  type IconResizer,
  type PWASettings,
} from '../apps/api/src/services/pwa.service';
import { iconBackground, MASKABLE_SAFE_ZONE } from '../apps/api/src/lib/images/icon-resizer';

export const REQUIRED_ICON_KEYS = [
  'iconSource',
  'icon192',
  'icon384',
  'icon512',
  'iconAppleTouch',
  'favicon32',
  'favicon16',
  'maskableIcon',
] as const;

const MIN_SOURCE_PX = 512;
/** Below this a logo would be blurry once scaled up to 512: skipped, not faked. */
const MIN_LOGO_PX = 256;
const MAX_SOURCE_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;
const BATCH = 50;

export function parseArgs(argv: string[]) {
  const val = (flag: string) => {
    const i = argv.indexOf(flag);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  const n = Number(val('--limit'));
  return {
    apply: argv.includes('--apply'),
    store: val('--store'),
    after: val('--after'),
    limit: Number.isInteger(n) && n > 0 ? n : undefined,
  };
}

/** Whether `updateSettings`' own returned row shows the icon set we asked it to write. */
export function iconWriteLanded(
  returned: Partial<PWASettings>,
  expected: Pick<PWASettings, 'iconAppleTouch'>
): boolean {
  return returned.iconAppleTouch === expected.iconAppleTouch;
}

export function iconSetComplete(settings: Partial<PWASettings>): boolean {
  return REQUIRED_ICON_KEYS.every(k => Boolean(settings[k]));
}

export function pickIconSource(
  settings: Partial<PWASettings>,
  logo: string | null | undefined
): string | null {
  const pick = [settings.iconSource, settings.icon512, settings.icon192, logo?.trim()].find(
    v => typeof v === 'string' && v.length > 0
  );
  return pick ?? null;
}

/** The URL comes from a merchant-editable column: public https hosts only (no SSRF into the LAN). */
export function safeSourceUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal')) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(':')) return false; // IP literals
  return true;
}

export type SourceVerdict = { png: Buffer } | { skip: 'source_unreadable' | 'source_too_small' };

/** A square PNG >= 512 passes untouched; anything else becomes one (centred, transparent). */
export async function normalizeSource(bytes: Buffer): Promise<SourceVerdict> {
  let meta: sharp.Metadata;
  try {
    meta = await sharp(bytes).metadata();
  } catch {
    return { skip: 'source_unreadable' };
  }
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  if (!w || !h) return { skip: 'source_unreadable' };
  if (meta.format === 'png' && w === h && w >= MIN_SOURCE_PX) return { png: bytes };
  if (Math.max(w, h) < MIN_LOGO_PX) return { skip: 'source_too_small' };
  const side = Math.max(MIN_SOURCE_PX, Math.max(w, h));
  const out = await sharp(bytes, { density: 384 })
    .resize(side, side, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  return { png: out };
}

/** Same geometry as the Workers Images path (lib/images/icon-resizer.ts renderIcon). */
export const sharpResizer: IconResizer = async (source, target, background) => {
  const clear = { r: 0, g: 0, b: 0, alpha: 0 };
  if (!target.padded) {
    return sharp(source)
      .resize(target.size, target.size, { fit: 'contain', background: clear })
      .png()
      .toBuffer();
  }
  const inner = Math.round(target.size * MASKABLE_SAFE_ZONE);
  const pad = (target.size - inner) / 2;
  const hex = iconBackground(background);
  const rgb = sharp({ create: { width: 1, height: 1, channels: 3, background: hex } });
  const { data } = await rgb.raw().toBuffer({ resolveWithObject: true });
  const bg = { r: data[0], g: data[1], b: data[2], alpha: 1 };
  return sharp(source)
    .resize(inner, inner, { fit: 'contain', background: bg })
    .extend({ top: pad, bottom: pad, left: pad, right: pad, background: bg })
    .flatten({ background: bg })
    .png()
    .toBuffer();
};

export interface BackfillDeps {
  fetchSource(url: string): Promise<Buffer>;
  generate(storeId: string, png: Buffer, background?: string): Promise<GeneratedPwaIcons>;
  /** Fresh read of the store's pwaSettings (the race check right before the write). */
  readSettings(storeId: string): Promise<Partial<PWASettings>>;
  write(storeId: string, icons: GeneratedPwaIcons): Promise<Partial<PWASettings>>;
}

export interface StoreRow {
  id: string;
  slug: string;
  logo: string | null;
  pwaSettings: unknown;
}

export type Outcome =
  | { status: 'generated' | 'would_generate'; source: string }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; error: string };

export async function backfillStore(
  store: StoreRow,
  apply: boolean,
  deps: BackfillDeps
): Promise<Outcome> {
  const settings = (store.pwaSettings as Partial<PWASettings> | null) ?? {};
  if (iconSetComplete(settings)) return { status: 'skipped', reason: 'complete' };
  const source = pickIconSource(settings, store.logo);
  if (!source) return { status: 'skipped', reason: 'no_logo' };
  if (!safeSourceUrl(source)) return { status: 'skipped', reason: 'unsafe_source_url' };

  try {
    const verdict = await normalizeSource(await deps.fetchSource(source));
    if ('skip' in verdict) return { status: 'skipped', reason: verdict.skip };
    if (!apply) return { status: 'would_generate', source };

    const icons = await deps.generate(store.id, verdict.png, settings.backgroundColor);
    // The merchant may have finished their own upload while we resized: theirs wins.
    if (iconSetComplete(await deps.readSettings(store.id))) {
      return { status: 'skipped', reason: 'raced' };
    }
    const returned = await deps.write(store.id, icons);
    if (!iconWriteLanded(returned, icons)) {
      throw new Error(
        `updateSettings returned iconAppleTouch=${returned.iconAppleTouch ?? '(unset)'}, expected ${icons.iconAppleTouch}: the write did not land`
      );
    }
    return { status: 'generated', source };
  } catch (err) {
    return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
  }
}

async function fetchImageBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: 'error',
  });
  if (!res.ok) throw new Error(`fetch ${url} -> HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_SOURCE_BYTES)
    throw new Error(`source is ${buf.length} bytes (max ${MAX_SOURCE_BYTES})`);
  return buf;
}

const liveDeps: BackfillDeps = {
  fetchSource: fetchImageBuffer,
  generate: (storeId, png, background) =>
    generatePwaIconSet(storeId, png, { background, resizer: sharpResizer }),
  readSettings: async storeId =>
    ((await prisma.store.findUnique({ where: { id: storeId }, select: { pwaSettings: true } }))
      ?.pwaSettings ?? {}) as Partial<PWASettings>,
  write: async (storeId, icons) =>
    (await PWAService.updateSettings(storeId, { settings: icons })).settings,
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `Mode: ${args.apply ? 'APPLY' : 'DRY-RUN'}${args.store ? `, store ${args.store}` : ''}${args.after ? `, after ${args.after}` : ''}${args.limit ? `, limit ${args.limit}` : ''}`
  );

  const counts: Record<string, number> = {};
  const bump = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);
  let processed = 0; // incomplete stores this run touched (the --limit unit)
  let cursor = args.after;
  let lastId: string | undefined;
  let exhausted = false;

  while (!exhausted && (!args.limit || processed < args.limit)) {
    const rows = await prisma.store.findMany({
      where: {
        pwaEnabled: true,
        ...(args.store ? { OR: [{ id: args.store }, { slug: args.store }] } : {}),
      },
      select: { id: true, slug: true, logo: true, pwaSettings: true },
      orderBy: { id: 'asc' },
      take: BATCH,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (rows.length === 0) break;
    for (const store of rows) {
      lastId = cursor = store.id;
      if (args.limit && processed >= args.limit) break;
      const out = await backfillStore(store, args.apply, liveDeps);
      const tag = out.status === 'skipped' ? `skipped:${out.reason}` : out.status;
      bump(tag);
      if (!(out.status === 'skipped' && out.reason === 'complete')) processed += 1;
      const detail =
        out.status === 'failed'
          ? out.error
          : out.status === 'skipped'
            ? out.reason
            : `from ${out.source}`;
      console.log(`  ${tag.toUpperCase().padEnd(24)} ${store.slug} (${store.id}) ${detail}`);
    }
    exhausted = rows.length < BATCH;
  }

  console.log(`\n${JSON.stringify(counts)}`);
  if (args.limit && processed >= args.limit && lastId) {
    console.log(
      `More may remain. Resume: npx tsx scripts/backfill-store-pwa-icons.ts${args.apply ? ' --apply' : ''} --after ${lastId} --limit ${args.limit}`
    );
  }
  if (!args.apply) console.log('DRY RUN: pass --apply to write.');
  if ((counts.failed ?? 0) > 0) process.exitCode = 1;
}

// Only when run as a CLI, never as a side effect of a test importing the helpers above.
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
    .catch(err => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
