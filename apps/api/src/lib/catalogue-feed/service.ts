import { getCached } from '../public-cache';
import { readInStoreContext } from '../store-scoped-read';
import { storeDb } from '../repo-factory';
import {
  listSellableBundles,
  describeBundleContents,
  withinSaleWindow,
} from '../../services/bundle.service';
import {
  buildBundleItems,
  buildProductItems,
  type BuildContext,
  type FeedBundleRow,
  type FeedIssue,
  type FeedLang,
} from './build';
import { loadFeedStore, loadProductChunk } from './load';
import {
  itemCsvRow,
  itemXml,
  tiktokHeaderRow,
  xmlHead,
  XML_TAIL,
  type FeedPlatform,
} from './render';

/**
 * Feed assembly + cache.
 *
 * CACHE CLASS (Ruling FEEDS-4): price, stock and availability are NEVER-stale for an advertising feed, so
 *  - the cached part lives under `public:products:<storeId>:feedx:` - the prefix `clearProductsRedis` drops on EVERY product,
 *    variant, price, stock, category, bundle and order write path (invalidateStoreProductCaches /
 *    invalidateStoreProductCachesAfterOrder), clearing the KV/Redis layer immediately;
 *  - the `inventory.backorder` entitlement is part of the KEY (not the value), so flipping it can never serve the other state;
 *  - bundles are NOT in the cached part: their sale window is applied per request (a window boundary is not a write);
 *  - the edge/CDN copy (which a write cannot purge off a third party's own cache) is BOUNDED-stale: 300 s, no
 *    stale-while-revalidate, 60 s for a store that sells gold-rate products. Ad platforms fetch on a schedule of an hour or
 *    more, so the edge window is shorter than the shortest fetch interval; checkout re-prices from the database regardless.
 */
export const PART_ITEMS = 5000;
export const FEED_EDGE_SECONDS = 300;
export const FEED_EDGE_SECONDS_GOLD = 60;
const CACHE_TTL = 600;
/** A hard stop for one scan (health / part build): 500 chunks of 100 products. */
const MAX_CHUNKS = 500;

export const feedPartKey = (
  storeId: string,
  p: FeedPlatform,
  lang: FeedLang,
  backorderOn: boolean,
  part: number
) => `public:products:${storeId}:feedx:v1:${p}:${lang}:bo${backorderOn ? 1 : 0}:${part}`;
const metaKey = (storeId: string) => `public:products:${storeId}:feedx:meta:v1`;
export const healthKey = (storeId: string, lang: FeedLang) =>
  `admin:products:${storeId}:feed-health:v1:${lang}`;

interface CachedPart {
  body: string;
  nextCursor: string | null;
  items: number;
}

async function context(
  storeId: string,
  lang: FeedLang,
  backorderOn: boolean
): Promise<BuildContext> {
  const { store, categories } = await loadFeedStore(storeId);
  return { store, lang, backorderOn, categoryById: categories };
}

const renderItems = (
  platform: FeedPlatform,
  items: ReturnType<typeof buildProductItems>['items']
) =>
  platform === 'tiktok'
    ? items.map(itemCsvRow).join('')
    : items.map(i => itemXml(i, platform)).join('');

async function buildPart(
  storeId: string,
  platform: FeedPlatform,
  lang: FeedLang,
  backorderOn: boolean,
  part: number
): Promise<CachedPart | null> {
  let cursor: string | null = null;
  if (part > 1) {
    const prev = await getPart(storeId, platform, lang, backorderOn, part - 1);
    if (!prev || !prev.nextCursor) return null; // no such part
    cursor = prev.nextCursor;
  }
  const ctx = await context(storeId, lang, backorderOn);
  const chunks: string[] = [];
  let items = 0;
  for (let i = 0; i < MAX_CHUNKS; i++) {
    const chunk = await loadProductChunk(storeId, cursor);
    const built = buildProductItems(chunk.products, ctx);
    chunks.push(renderItems(platform, built.items));
    items += built.items.length;
    cursor = chunk.nextCursor;
    if (!cursor || items >= PART_ITEMS) break;
  }
  return { body: chunks.join(''), nextCursor: cursor, items };
}

function getPart(
  storeId: string,
  platform: FeedPlatform,
  lang: FeedLang,
  backorderOn: boolean,
  part: number
): Promise<CachedPart | null> {
  return getCached<CachedPart | null>(
    feedPartKey(storeId, platform, lang, backorderOn, part),
    CACHE_TTL,
    () => readInStoreContext(storeId, () => buildPart(storeId, platform, lang, backorderOn, part)),
    { cacheIf: v => v !== null }
  );
}

interface MetaCache {
  bundles: FeedBundleRow[];
  hasGold: boolean;
}
function getMeta(storeId: string, bundlesEnabled: boolean): Promise<MetaCache> {
  return getCached<MetaCache>(metaKey(storeId), CACHE_TTL, () =>
    readInStoreContext(storeId, async () => {
      const db = await storeDb(storeId);
      const bundles = bundlesEnabled
        ? (await listSellableBundles(db as never, storeId)).map(b => {
            const { description, descriptionAr } = describeBundleContents(b);
            return {
              id: b.id,
              name: b.name,
              nameAr: b.nameAr,
              slug: b.slug,
              image: b.image,
              price: b.price,
              componentSum: b.componentSum,
              description,
              descriptionAr,
              startsAt: b.startsAt,
              expiresAt: b.expiresAt,
            } as FeedBundleRow;
          })
        : [];
      const hasGold =
        (await db.product.count({
          where: {
            storeId,
            status: 'active',
            audience: 'public',
            pricingMode: 'gold_rate',
            deletedAt: null,
          },
          take: 1,
        })) > 0;
      return { bundles, hasGold };
    })
  );
}

export interface FeedDocument {
  body: string;
  contentType: string;
  nextPart: number | null;
  /** Edge window to send (seconds). */
  edgeSeconds: number;
}

/** One part of a platform feed; null = no such part (404). */
export async function renderFeed(opts: {
  storeId: string;
  platform: FeedPlatform;
  lang: FeedLang;
  part: number;
  backorderOn: boolean;
  bundlesEnabled: boolean;
  now?: Date;
}): Promise<FeedDocument | null> {
  const { storeId, platform, lang, part, backorderOn, bundlesEnabled } = opts;
  const cached = await getPart(storeId, platform, lang, backorderOn, part);
  if (!cached) return null;
  const meta = await getMeta(storeId, bundlesEnabled);
  const last = cached.nextCursor === null;
  const ctx = await readInStoreContext(storeId, () => context(storeId, lang, backorderOn));
  const live = last ? meta.bundles.filter(b => withinSaleWindow(b, opts.now ?? new Date())) : [];
  const bundleItems = buildBundleItems(live, ctx);
  const bundlesBody = renderItems(platform, bundleItems);
  const edgeSeconds = meta.hasGold ? FEED_EDGE_SECONDS_GOLD : FEED_EDGE_SECONDS;
  if (platform === 'tiktok') {
    return {
      body: tiktokHeaderRow() + cached.body + bundlesBody,
      contentType: 'text/csv; charset=utf-8',
      nextPart: cached.nextCursor ? part + 1 : null,
      edgeSeconds,
    };
  }
  const name = lang === 'ar' && ctx.store.nameAr ? ctx.store.nameAr : ctx.store.name;
  return {
    body:
      xmlHead({ storeName: name, origin: ctx.store.origin, lang }) +
      cached.body +
      bundlesBody +
      XML_TAIL,
    contentType: 'application/xml; charset=utf-8',
    nextPart: cached.nextCursor ? part + 1 : null,
    edgeSeconds,
  };
}

// ---- health -----------------------------------------------------------------------------------------------------------

export interface FeedHealth {
  lang: FeedLang;
  origin: string;
  items: number;
  products: number;
  /** Feeds are split every PART_ITEMS items: how many files a platform must be given. */
  parts: number;
  excluded: number;
  warnings: number;
  byCode: Record<string, number>;
  /** Excluded first, then warnings; capped at ISSUE_CAP rows (counts above are over everything). */
  issues: FeedIssue[];
  issuesTruncated: boolean;
  notPublished: { draft: number; archived: number; wholesaleOnly: number };
  shippingFlat: boolean;
  scanTruncated: boolean;
  /** A merchant's setup question: is anything advertisable at all. */
  generatedAt: string;
}
const ISSUE_CAP = 300;

export function getFeedHealth(
  storeId: string,
  lang: FeedLang,
  backorderOn: boolean
): Promise<FeedHealth> {
  return getCached<FeedHealth>(healthKey(storeId, lang), 120, () =>
    readInStoreContext(storeId, async () => {
      const ctx = await context(storeId, lang, backorderOn);
      const byCode: Record<string, number> = {};
      const excluded: FeedIssue[] = [];
      const warnings: FeedIssue[] = [];
      let items = 0,
        products = 0,
        cursor: string | null = null,
        scanTruncated = false;
      for (let i = 0; ; i++) {
        if (i >= MAX_CHUNKS) {
          scanTruncated = true;
          break;
        }
        const chunk = await loadProductChunk(storeId, cursor);
        products += chunk.products.length;
        const built = buildProductItems(chunk.products, ctx);
        items += built.items.length;
        for (const is of built.issues) {
          byCode[is.code] = (byCode[is.code] ?? 0) + 1;
          (is.kind === 'excluded' ? excluded : warnings).push(is);
        }
        // keep memory bounded on a huge store: only the first ISSUE_CAP of each kind are needed
        if (excluded.length > ISSUE_CAP) excluded.length = ISSUE_CAP + 1;
        if (warnings.length > ISSUE_CAP) warnings.length = ISSUE_CAP + 1;
        cursor = chunk.nextCursor;
        if (!cursor) break;
      }
      const db = await storeDb(storeId);
      const [draft, archived, wholesaleOnly] = await Promise.all([
        db.product.count({ where: { storeId, status: 'draft', deletedAt: null } }),
        db.product.count({ where: { storeId, status: 'archived', deletedAt: null } }),
        db.product.count({
          where: { storeId, status: 'active', audience: 'wholesale_only', deletedAt: null },
        }),
      ]);
      const all = [...excluded, ...warnings];
      return {
        lang,
        origin: ctx.store.origin,
        items,
        products,
        parts: Math.max(1, Math.ceil(items / PART_ITEMS)),
        excluded: Object.entries(byCode)
          .filter(([c]) => EXCLUDE_CODES.has(c))
          .reduce((n, [, v]) => n + v, 0),
        warnings: Object.entries(byCode)
          .filter(([c]) => !EXCLUDE_CODES.has(c))
          .reduce((n, [, v]) => n + v, 0),
        byCode,
        issues: all.slice(0, ISSUE_CAP),
        issuesTruncated: all.length > ISSUE_CAP,
        notPublished: { draft, archived, wholesaleOnly },
        shippingFlat: ctx.store.flatShippingMinor != null,
        scanTruncated,
        generatedAt: new Date().toISOString(),
      };
    })
  );
}
const EXCLUDE_CODES = new Set([
  'no_image',
  'zero_price',
  'variant_inactive',
  'no_title',
  'bundle_not_sellable',
]);
