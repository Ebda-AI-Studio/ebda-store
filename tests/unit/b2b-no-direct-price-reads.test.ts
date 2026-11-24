/**
 * Architecture guard (design review section 7 + Task 3 money review M-4, docs/plans/done/2026-10-21-b2b-wholesale.md): after this
 * change a charged or customer-visible unit price is decided in ONE place, `PriceResolver` (and the pure `resolveUnitPrice`
 * under it). Every other read of a `price` / `unitPrice` in apps/api/src is either feeding the resolver, reading a PERSISTED
 * order value, a retail display, a catalogue read, an admin display, a writer, or a bundle base price, and must say so in the
 * allow-list below.
 *
 * The allow-list is PER FILE AND PER SYMBOL, with an exact read count: `reads: { 'POST /': 6 }` means that route handler
 * (Express handlers are reported as `METHOD /path`, not lumped into one `<module>` bucket) may contain exactly six price
 * reads. A new read anywhere in an allow-listed file, in a new function or handler, or one more in an existing one, changes
 * the picture and turns this red until a reviewer classifies it. The scan is AST based (TypeScript compiler API) and catches
 * `p?.price`, destructuring `{ price }`, a Prisma `price: true` select, `x['price']` and raw SQL naming a price column.
 * `evaluatePriceReads` is a pure function so each bypass is PLANTED below and shown to go red.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, relative, dirname } from 'node:path';
import ts from 'typescript';
import { scanPriceReads, scanSource, type PriceRead } from '../helpers/price-read-scan';

const API_SRC = process.env.B2B_API_SRC ?? resolve(__dirname, '../../apps/api/src');

type Category =
  | 'resolver-input' // reads base prices ONLY to hand them to PriceResolver on a money path
  | 'resolver-output' // displays a price the resolver already decided
  | 'persisted' // reads an OrderItem / Order value snapshotted at sale time, never re-resolved
  | 'retail-display' // anonymous retail / public "from" price shown outside the cart flow
  | 'catalog-read' // product catalogue read / shaping (public payload strips group prices)
  | 'admin-display' // merchant-facing read of list price
  | 'writer' // writes a price (merchant edits / imports); tier validation lives in Task 4
  | 'bundle-base' // bundles are priced at base by design (Ruling B2B-8)
  | 'unrelated'; // not a product price (plan billing, carrier quote, AI eval)

interface AllowEntry {
  category: Category;
  reason: string;
  /** Exact number of price reads per symbol (function / method / `METHOD /path` route handler). */
  reads: Record<string, number>;
}

const ALLOW: Record<string, AllowEntry> = {
  'lib/wa/bridge/do-port.ts': {
    category: 'retail-display',
    reason:
      'Ruling WA-RPC-6: the Ebda Chat catalog feed shows the ANONYMOUS retail price (product / variant `price`, the same the public storefront shows) as Meta catalog rows. It never decides a charged price: createOrderFromChat hands lines to the DO money core (placeOrder), which resolves every price, tier, group price and fee itself; a quote shown in chat is re-priced at order time',
    reads: { '<module>': 1, rowsForProducts: 3 },
  },
  'cf/store-do/repo.ts': {
    category: 'unrelated',
    reason:
      'INFRA-CF-1 Phase 0 demo operations of the StoreDO: seed writes the demo catalogue and listProducts shows RETAIL prices; both reachable only for a flagged store plus x-ebda-backend: do. The order path no longer prices anything here: createOrder hands the cart to the DO money core (packages/repo placeOrder), which resolves every price',
    reads: { seed: 2, listProducts: 1 },
  },
  'services/gold-rate/gate.ts': {
    category: 'catalog-read',
    reason:
      "Ruling B5-17: the order gate recomputes a gold line's BASE price from its spec (computeGoldUnitPrice) and compares it with the stored base (re-read in the gate, and again inside the money transaction, B5-36) and the base the caller hands to PriceResolver; goldQuotesForLines reads the base price the cart stores as the shopper's quote. The gate never decides a charged price",
    reads: {
      '<module>': 2,
      priceAll: 1,
      readGoldState: 2,
      assertSameRates: 2,
      buildGoldSnapshot: 1,
      goldQuotesForLines: 4,
    },
  },
  'services/gold-rate/feed/gold-api.ts': {
    category: 'unrelated',
    reason:
      'the XAU/USD spot quote of the automatic gold rate (Ruling B5-15): a market figure, not a product price',
    reads: { fetchXauUsdMicro: 1 },
  },
  'services/gold-rate/repricer.ts': {
    category: 'writer',
    reason:
      "Ruling B5-13: the repricer is the ONE writer of a gold-priced row's materialised price (computeGoldUnitPrice), min-of-variants for the parent; it reads current prices only to skip unchanged rows",
    reads: { '<module>': 2, planProduct: 13, priceOf: 1, writePlan: 4 },
  },
  'services/gold-rate/gold-rate.service.ts': {
    category: 'writer',
    reason:
      "Ruling B5-13/B5-19: setProductPricing reads a product's price to freeze it when a gold product goes back to fixed (audit row) and to return the new price; it also reads each variant's own price to refuse a fixed variant that has none (B5-36); the Durable Object branch (CF-LAST-1) reads the frozen price once more",
    reads: { setProductPricing: 7 },
  },
  'services/cart.service.ts': {
    category: 'resolver-input',
    reason: 'computeTotals feeds item/variant base prices to priceCart',
    reads: { '<module>': 1, acknowledgePrices: 4, computeTotals: 6 },
  },
  'services/order.service.ts': {
    category: 'resolver-input',
    reason: 'create + createAdminOrder feed base prices to priceCart; persisted values elsewhere',
    reads: { create: 9, createAdminOrder: 4 },
  },
  'routes/promotion.routes.ts': {
    category: 'resolver-input',
    reason: 'preview lines priced via priceCart',
    // One shared handler serves the checkout route (/preview) and the browse route (/preview-browse).
    reads: { makePreviewHandler: 2 },
  },
  'services/cart-recovery-email.service.ts': {
    category: 'resolver-output',
    reason:
      'parses the abandonment snapshot, whose prices abandoned-cart.service already took from the resolver',
    reads: { parseItems: 2 },
  },
  'services/email-templates/cart-recovery.ts': {
    category: 'resolver-output',
    reason: 'renders snapshot line prices that came from the resolver',
    reads: { rows: 1 },
  },
  'services/abandoned-cart.service.ts': {
    category: 'resolver-input',
    reason:
      'recovery totals via priceCart for the cart owner (the candidate include selects the variant price the resolver is fed)',
    reads: { detectNewAbandonments: 4, '<module>': 1 },
  },
  'services/price-resolver.service.ts': {
    category: 'resolver-input',
    reason: 'the loader itself',
    reads: { priceCart: 3 },
  },
  'mcp/tools/cart.tools.ts': {
    category: 'resolver-output',
    reason:
      'cartView shows the service-resolved unitPrice (retail fallback for an unavailable line)',
    reads: { cartView: 3 },
  },
  'lib/payment-line-items.ts': {
    category: 'persisted',
    reason: 'payment-provider line items from OrderItem.price',
    reads: { buildPaymentLineItems: 1 },
  },
  'services/invoice.service.ts': {
    category: 'persisted',
    reason: 'invoice lines from OrderItem snapshots',
    reads: { generateInvoice: 3, renderInvoiceEmailContent: 1 }, // +1: the struck list price compares to the snapshot price
  },
  'lib/order-pricing.ts': {
    category: 'persisted',
    reason:
      'struckListPrice compares the persisted list price with the persisted paid price (invoice display)',
    reads: { struckListPrice: 1 },
  },
  'services/fiscal-document-render.ts': {
    category: 'persisted',
    reason: 'fiscal document lines',
    reads: { renderFiscalDocumentHtml: 2 },
  },
  'services/fiscal-document.service.ts': {
    category: 'persisted',
    reason: 'sale lines from persisted order items',
    reads: { buildSaleLines: 1 },
  },
  'services/return.service.ts': {
    category: 'persisted',
    reason:
      'refund math uses OrderItem.price (RF11); Task 8b adds the tier adjustment from snapshots',
    // snapshots only: <module> = the ADJUSTMENT_LINE_SELECT column list; lineAdjustmentsFrom = paid price into the product-scope
    // repricing (B2B-17) and the standard refund; create's estimate goes through the same helper (review P2-1)
    reads: { '<module>': 1, complete: 1, create: 1, refundPreview: 1, lineAdjustmentsFrom: 3 },
  },
  'services/accounting/backorder.service.ts': {
    category: 'persisted',
    reason: 'backorder lines of persisted orders',
    reads: { cancelBackorder: 1, listOpenBackorders: 1 },
  },
  'services/accounting/posting/partial-return-allocation.ts': {
    category: 'persisted',
    reason: 'allocation over persisted lines',
    reads: { allocatePartialReturn: 5 }, // + the discount-eligible gross (final review P2-2)
  },
  'services/email-templates/order-confirmation.ts': {
    category: 'persisted',
    reason: 'renders persisted order items',
    reads: { ar: 1, en: 1 },
  },
  'routes/barcode-labels.routes.ts': {
    category: 'admin-display',
    reason:
      'BARCODE-1 label picker: the merchant prints the LIST price (variant price, else product price) on a shelf tag; display only, nothing is charged from it',
    reads: { 'GET /:storeId/barcodes/items': 5 },
  },
  'routes/order.routes.ts': {
    category: 'persisted',
    reason: 'order detail / timeline reads of persisted items',
    reads: { 'GET /export.xlsx': 2 },
  },
  'routes/payment-abandonments.routes.ts': {
    category: 'persisted',
    reason: 'reads the persisted order amount / items (verified: no re-pricing)',
    reads: { 'GET /': 2 },
  },
  'routes/customers.routes.ts': {
    category: 'persisted',
    reason: 'customer export of persisted order items',
    reads: { 'GET /customers/export.xlsx': 1 },
  },
  'services/customer-aggregate.service.ts': {
    category: 'persisted',
    reason: 'aggregates persisted orders',
    reads: { aggregateCustomersUncached: 1, getCustomerProfile: 1 },
  },
  'lib/inngest/functions/order-created.ts': {
    category: 'persisted',
    reason: 'email fan-out from persisted items',
    reads: { '<module>': 1 },
  },
  'lib/inngest/functions/order-status-changed.ts': {
    category: 'persisted',
    reason: 'fan-out from persisted items',
    reads: { handleOrderStatusChanged: 1 },
  },
  'services/payment-providers/fawry.provider.ts': {
    category: 'persisted',
    reason: 'provider payload from persisted order lines',
    reads: { createPayment: 3 },
  },
  'services/payment-providers/paymob.provider.ts': {
    category: 'persisted',
    reason: 'provider payload from persisted order lines',
    reads: { createPayment: 3 },
  },
  'services/shipping-carrier.service.ts': {
    category: 'persisted',
    reason: 'declared value from persisted lines',
    reads: { createShipmentForOrder: 1 },
  },
  'lib/catalogue-feed/build.ts': {
    category: 'retail-display',
    reason: 'public ad feeds (Google/Meta/TikTok): retail price, anonymous-safe',
    reads: { buildProductItems: 3, buildBundleItems: 4 },
  },
  'lib/catalogue-feed/load.ts': {
    category: 'retail-display',
    reason: 'public ad feeds: retail price select, public-audience products only',
    reads: { '<module>': 2 },
  },
  'lib/catalogue-feed/service.ts': {
    category: 'retail-display',
    reason: 'public ad feeds: purchasable bundle price',
    reads: { getMeta: 1 },
  },
  'lib/inngest/functions/order-capi-conversion.ts': {
    category: 'persisted',
    reason: 'server-side Purchase lines from persisted order items',
    reads: { '<module>': 1 },
  },
  'services/pixels-capi.service.ts': {
    category: 'persisted',
    reason: 'server-side Purchase lines from persisted order items',
    reads: { purchaseContents: 1, sendMetaCAPI: 1, sendTikTokCAPI: 1 },
  },
  'lib/product-feed.ts': {
    category: 'retail-display',
    reason: 'public feed: retail price, anonymous-safe',
    reads: { buildProductFeed: 6 },
  },
  'lib/wishlist-card.ts': {
    category: 'retail-display',
    reason: 'wishlist card: retail, B2B-9 cards unchanged',
    reads: { '<module>': 1, wishlistCardProduct: 3 },
  },
  'mcp/tools/catalog.tools.ts': {
    category: 'retail-display',
    reason: 'MCP catalogue is anonymous',
    reads: { registerCatalogTools: 2, toSummary: 1 },
  },
  'services/recommendation.service.ts': {
    category: 'retail-display',
    reason: 'recommendation select: retail',
    reads: { '<module>': 2 },
  },
  'lib/inngest/functions/bulk-ai-geo.ts': {
    category: 'retail-display',
    reason: 'AI copy uses retail price',
    reads: { '<module>': 1 },
  },
  'routes/ai.routes.ts': {
    category: 'retail-display',
    reason: 'AI prompts use retail price',
    reads: { 'GET /results/recommendations': 1 },
  },
  'services/webhook-payload.ts': {
    category: 'admin-display',
    reason:
      "the merchant's own webhook event payload: order lines carry the price actually charged (snapshot), product events carry the merchant's list price; it goes to the merchant's endpoint, never to a shopper",
    reads: { formatOrderParts: 1, loadOrderParts: 1, loadProductData: 2 },
  },
  'services/product.service.ts': {
    category: 'catalog-read',
    reason:
      'product CRUD + public payload; Task 4/6 add tiers and strip group prices; QA-PRICE-ZERO-1 refuses an ACTIVE row at price 0 (validation of the written list price, never a charged price)',
    reads: {
      '<module>': 3,
      advancedSearch: 9,
      bulkUpdate: 13,
      create: 2,
      getById: 1,
      getFilterOptions: 4,
      getSearchSuggestions: 1,
      getSuggestSuggestions: 2,
      listPublic: 1, // the `sort=on_sale` raw SQL ranks by the retail compare-at drop (ordering only; the card price still goes through b2bPublicFields), B2-28. PL1 moved the min/max price filter out into priceRangeWhere (-4 reads)
      // PL1: the price filter's slider ceiling = the store's highest retail list / variant price, a display bound for the filter UI; never a charged price
      catalogueMaxPrice: 4,
      // the DO twin of the `sort=on_sale` statement: ranks by the retail compare-at drop (ordering only, the card price still
      // goes through b2bPublicFields), P1 2026-11-09
      onSaleIdsFromDo: 4,
      reshapePublicProductDetail: 2,
      update: 6,
      b2bPublicFields: 3, // product price + variant.price ?? product.price: hides a stale variant tier (final review minor 2)
    },
  },
  'smart-layer/tools/products.tools.ts': {
    category: 'admin-display',
    reason:
      'merchant-facing assistant card: the list price the merchant is changing, shown before and after',
    reads: { state: 1, createInput: 1, describe: 1 },
  },
  'smart-layer/tools/orders.tools.ts': {
    category: 'admin-display',
    reason:
      'merchant-facing assistant confirm card: the order total / line prices the merchant is about to act on',
    reads: { state: 1, describe: 2 },
  },
  'smart-layer/tools/products-confirm.tools.ts': {
    category: 'admin-display',
    reason:
      'merchant-facing assistant confirm card: the list price a delete or bulk price change acts on, and the before-price the undo restores',
    reads: { state: 1, describe: 2, afterPrice: 1, plan: 4, resolveItems: 1, run: 3 },
  },
  'smart-layer/tools/marketing.tools.ts': {
    category: 'admin-display',
    reason: 'merchant-facing assistant card: the list price a bundle or coupon is computed against',
    reads: { state: 2 },
  },
  'mcp/tools/admin-read.tools.ts': {
    category: 'admin-display',
    reason: 'merchant read of list price',
    reads: { productSummary: 1, registerAdminReadTools: 2 },
  },
  'routes/wholesale.routes.ts': {
    category: 'resolver-input',
    reason: 'POST /public/pricing/resolve feeds base prices to priceLine for the signed-in buyer',
    reads: { 'POST /pricing/resolve': 4 },
  },
  'services/price-tier.service.ts': {
    category: 'writer',
    reason: 'merchant tier writes validate against the current base price (Task 4)',
    reads: { loadProduct: 1, validate: 3, list: 3 },
  },
  'services/catalog-import.service.ts': {
    category: 'writer',
    reason:
      'publish verifies a catalogue-import DRAFT has a price above zero (a draft cannot be bought); it reads the stored base price to refuse a zero-price publish, never to price a sale',
    reads: { publishItems: 5 },
  },
  'services/bulk.service.ts': {
    category: 'writer',
    reason:
      'bulk price edits / import; Task 4 returns tier-above-base warnings; QA-PRICE-ZERO-1 refuses an ACTIVE row at price 0 (validation of the written list price, never a charged price)',
    reads: {
      buildProductFields: 1,
      bulkUpdateStatus: 2,
      createVariantsForProductTx: 1,
      exportProducts: 2,
      importProducts: 10,
    },
  },
  'routes/bulk.routes.ts': {
    category: 'writer',
    reason: 'bulk edit route',
    reads: { 'GET /:storeId/bulk/export.xlsx': 1, 'POST /:storeId/bulk/import-preview': 2 },
  },
  'services/csv-import.ts': {
    category: 'writer',
    reason: 'CSV import',
    reads: { shopifyRecordsToRows: 9 },
  },
  'services/import-preview.ts': {
    category: 'writer',
    reason: 'import preview',
    reads: { buildImportPreview: 2 },
  },
  'lib/sellable-price.ts': {
    category: 'writer',
    reason:
      'QA-PRICE-ZERO-1: an ACTIVE product / variant must not be written at price 0 (reads the list price being written)',
    reads: { isFreeActiveProduct: 2, assertActiveVariantPrice: 1 },
  },
  'services/variant.service.ts': {
    category: 'writer',
    reason:
      'variant price edits; QA-PRICE-ZERO-1 refuses an ACTIVE row at price 0 (validation of the written list price, never a charged price)',
    reads: { createVariant: 4, createVariantRow: 1, getProductVariants: 1, updateVariant: 5 },
  },
  'routes/product.routes.ts': {
    category: 'writer',
    reason: 'fixed-discount refinement on product write',
    reads: { refineFixedDiscount: 2 },
  },
  'services/bundle.service.ts': {
    category: 'bundle-base',
    reason:
      'bundle components are priced at base; the PDP / routine saving (Phase B3) reads the RESOLVED bundle price and component sum, and a bundle with a wholesale-only component is not sellable so it never advertises a saving',
    reads: { resolveBundle: 4, listBundleSavingsForProducts: 2 },
  },
  'routes/bundle.routes.ts': {
    category: 'bundle-base',
    reason: 'bundle admin lines at base',
    reads: {
      'GET /public/:storeId/bundles': 1,
      'GET /public/:storeId/bundles/:slug': 1,
      resolveBundleLines: 3,
    },
  },
  'lib/cart-pricing.ts': {
    category: 'bundle-base',
    reason: 'retailUnitPrice: the labelled retail helper',
    reads: { retailUnitPrice: 2 },
  },
  'services/billing/account.service.ts': {
    category: 'unrelated',
    reason: 'subscription plan price (manual payment amount guard)',
    reads: { recordManualPayment: 1 },
  },
  'services/billing/subscription-billing.service.ts': {
    category: 'unrelated',
    reason: 'subscription plan price',
    reads: { changePlan: 1, loadPayablePlan: 1, selectTrialPlan: 1, startCheckout: 1 },
  },
  'services/carriers/bosta.carrier.ts': {
    category: 'unrelated',
    reason: 'carrier shipping quote',
    reads: { quote: 2 },
  },
  'lib/ai/eval/criteria.ts': {
    category: 'unrelated',
    reason: 'AI eval fixture',
    reads: { run: 2 },
  },
  'services/analytics.service.ts': {
    category: 'persisted',
    reason: 'revenue report over persisted order_items (raw SQL)',
    reads: { getPeriodStats: 1 },
  },
  'services/store-closure.service.ts': {
    category: 'persisted',
    reason: 'fiscal archive over persisted order lines (raw SQL)',
    reads: { archiveFiscalRecords: 1 },
  },
};

const SELF = new Set(['services/price-resolver.service.ts']);
/** Categories whose files must never be called FROM a money path for a price (except the named, pinned imports below). */
const NON_MONEY: Category[] = ['retail-display', 'catalog-read', 'admin-display', 'writer'];

/** Pure evaluation of scanned reads against an allow-list: returns human-readable violations (empty = clean). */
export function evaluatePriceReads(
  hits: readonly PriceRead[],
  allow: Record<string, AllowEntry>
): string[] {
  const out: string[] = [];
  const counts = new Map<string, number>();
  for (const h of hits) {
    const k = `${h.file}#${h.symbol}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
    if (!allow[h.file])
      out.push(`unlisted file ${h.file} reads ${h.name} (${h.kind}) in ${h.symbol}`);
  }
  for (const [k, n] of counts) {
    const [file, symbol] = k.split('#');
    const e = allow[file!];
    if (!e) continue;
    const want = e.reads[symbol!];
    if (want === undefined)
      out.push(`${file}: new symbol "${symbol}" reads a price (${n}x), not in the allow-list`);
    else if (want !== n) out.push(`${file}#${symbol}: ${n} price reads, allow-list pins ${want}`);
  }
  for (const [file, e] of Object.entries(allow)) {
    for (const symbol of Object.keys(e.reads)) {
      if (!counts.has(`${file}#${symbol}`))
        out.push(`${file}#${symbol}: allow-listed but no longer reads a price (remove it)`);
    }
  }
  return out;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      if (e === 'node_modules' || e === '__tests__') continue;
      walk(p, out);
    } else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}
const read = (rel: string) => readFileSync(join(API_SRC, rel), 'utf8');

describe('B2B: direct price reads are classified per file and per symbol (AST scan of apps/api/src)', () => {
  const hits = scanPriceReads(API_SRC);

  it('every price / unitPrice read matches the allow-list exactly: file, symbol (route handler) and count', () => {
    expect(evaluatePriceReads(hits, ALLOW)).toEqual([]);
  });

  it('every allow-list entry carries a reason', () => {
    for (const [f, v] of Object.entries(ALLOW)) expect(v.reason.length, f).toBeGreaterThan(8);
  });

  it('every money-path file ("resolver-input") actually routes through PriceResolver.forBuyer', () => {
    const notRouted = Object.entries(ALLOW)
      .filter(([f, v]) => v.category === 'resolver-input' && !SELF.has(f))
      .filter(
        ([f]) =>
          !/from ['"].*price-resolver\.service['"]/.test(read(f)) ||
          !/PriceResolver\.forBuyer\(/.test(read(f))
      )
      .map(([f]) => f);
    expect(notRouted).toEqual([]);
  });

  it('a money path imports NO price helper from a retail-display / catalog-read / admin-display / writer file, except the pinned ones', () => {
    // Without this a helper exported from a "retail" file could be called from checkout and bypass the resolver (M-4).
    const found: string[] = [];
    for (const [file, e] of Object.entries(ALLOW)) {
      if (e.category !== 'resolver-input' || SELF.has(file)) continue;
      const sf = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
      for (const st of sf.statements) {
        if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
        const spec = st.moduleSpecifier.text;
        if (!spec.startsWith('.')) continue;
        const target =
          relative(API_SRC, resolve(dirname(join(API_SRC, file)), spec)).replace(/\\/g, '/') +
          '.ts';
        const tEntry = ALLOW[target];
        if (!tEntry || !NON_MONEY.includes(tEntry.category)) continue;
        const names =
          st.importClause?.namedBindings && ts.isNamedImports(st.importClause.namedBindings)
            ? st.importClause.namedBindings.elements
                .map(el => el.name.text)
                .sort()
                .join(',')
            : '*';
        found.push(`${file} -> ${target}: ${names}`);
      }
    }
    expect(found.sort()).toEqual([
      // STOREFRONT_PRODUCT_SELECT is a Prisma select constant (no price decision).
      'routes/wholesale.routes.ts -> services/product.service.ts: ProductService', // the approved-buyer catalogue list / detail (no price decision)
      'services/cart.service.ts -> services/gold-rate/gate.ts: goldQuoteKey,goldQuotesForLines',
      'services/cart.service.ts -> services/product.service.ts: STOREFRONT_PRODUCT_SELECT',
      'services/order.service.ts -> services/gold-rate/gate.ts: assertGoldLinesPriceable,assertSameRates',
      'services/order.service.ts -> services/product.service.ts: STOREFRONT_PRODUCT_SELECT',
    ]);
  });

  it('only the bundle paths and the MCP cart view import the retail helper (lib/cart-pricing)', () => {
    const importers = walk(API_SRC)
      .map(f => relative(API_SRC, f))
      .filter(f => /from ['"][./]*(?:lib\/)?cart-pricing['"]/.test(read(f)))
      .sort();
    expect(importers).toEqual([
      'mcp/tools/cart.tools.ts',
      'routes/bundle.routes.ts',
      'services/bundle.service.ts',
    ]);
  });
});

describe('B2B (M-4): every known bypass is PLANTED and goes red', () => {
  // Only the violations about the planted file (the other files are not part of the plant).
  const planted = (file: string, code: string) =>
    evaluatePriceReads(scanSource(file, code), ALLOW).filter(v => v.includes(file));

  it('a new direct read in a brand-new file', () => {
    expect(
      planted('services/fake.ts', 'export const f = (i: any) => i.product?.price * i.quantity;')
    ).toEqual([expect.stringContaining('unlisted file services/fake.ts')]);
  });

  it('x["price"] element access (the bracket-notation bypass)', () => {
    const v = planted('services/fake.ts', "export const f = (i: any) => i.product['price'] * 2;");
    expect(v.join()).toMatch(/unlisted file services\/fake\.ts reads price \(element\)/);
  });

  it('x["unitPrice"] too', () => {
    expect(scanSource('x.ts', "const a = b['unitPrice'];").map(h => h.kind)).toEqual(['element']);
  });

  it('raw SQL that names a price column ($queryRaw tagged template and $queryRawUnsafe call)', () => {
    expect(
      scanSource('x.ts', 'await prisma.$queryRaw`SELECT price FROM products`;').map(h => h.kind)
    ).toEqual(['raw']);
    expect(
      scanSource('x.ts', "await prisma.$queryRawUnsafe('SELECT p.price FROM products p');").map(
        h => h.kind
      )
    ).toEqual(['raw']);
    expect(scanSource('x.ts', 'await prisma.$queryRaw`SELECT id FROM products`;')).toEqual([]);
  });

  it('a NEW function in an allow-listed file (per-symbol allow-list)', () => {
    const v = planted(
      'services/order.service.ts',
      'export function sneaky(i: any) { return i.product.price; }\nexport function create(){ ' +
        'const a = x.price; const b = x.price; const c = x.price; const d = x.price; const e = x.price; const f = x.price; const g = x.price; }'
    );
    expect(v.join('\n')).toMatch(/new symbol "sneaky" reads a price/);
  });

  it('ONE MORE read inside an existing allow-listed symbol (exact count)', () => {
    const ok = Array.from(
      { length: ALLOW['services/order.service.ts']!.reads.create! },
      () => 'x.price;'
    ).join(' ');
    expect(
      planted(
        'services/order.service.ts',
        `function create(){ ${ok} }\nfunction createAdminOrder(){ ${'x.price;'.repeat(ALLOW['services/order.service.ts']!.reads.createAdminOrder!)} }`
      )
    ).toEqual([]);
    const v = planted(
      'services/order.service.ts',
      `function create(){ ${ok} y.price; }\nfunction createAdminOrder(){ ${'x.price;'.repeat(ALLOW['services/order.service.ts']!.reads.createAdminOrder!)} }`
    );
    expect(v.join()).toMatch(
      /services\/order\.service\.ts#create: \d+ price reads, allow-list pins/
    );
  });

  it('swapping a resolver-input read for a direct charge read INSIDE an anonymous route handler keeps the count only if it is the same handler; a different handler is a new symbol', () => {
    // promotion preview: all reads live in one handler. A read added to a second handler is reported under ITS route, not hidden.
    const v = planted(
      'routes/promotion.routes.ts',
      'const makePreviewHandler = (browse) => async () => { ' +
        'a.price;'.repeat(ALLOW['routes/promotion.routes.ts']!.reads['makePreviewHandler']!) +
        " });\nrouter.get('/preview', async () => { b.price; });"
    );
    expect(v.join()).toMatch(/new symbol "GET \/preview" reads a price/);
  });

  it('route handlers are reported per route (METHOD /path), not as one <module> bucket', () => {
    const hits = scanSource(
      'routes/x.ts',
      "router.post('/a', async () => { p.price; });\nrouter.get('/b', async () => { q.price; });"
    );
    expect(hits.map(h => h.symbol)).toEqual(['POST /a', 'GET /b']);
  });

  it('an allow-listed symbol that stops reading a price must be removed (no stale entries)', () => {
    const v = evaluatePriceReads([], {
      'services/x.ts': { category: 'writer', reason: 'a stale entry', reads: { f: 1 } },
    });
    expect(v.join()).toMatch(/allow-listed but no longer reads a price/);
  });
});

describe('B2B: the forBuyer argument is never a literal', () => {
  it('no forBuyer( call passes an object literal, string, template or null as the buyer', () => {
    const bad: string[] = [];
    for (const abs of walk(API_SRC)) {
      const sf = ts.createSourceFile(abs, readFileSync(abs, 'utf8'), ts.ScriptTarget.Latest, true);
      const visit = (n: ts.Node) => {
        if (
          ts.isCallExpression(n) &&
          ts.isPropertyAccessExpression(n.expression) &&
          n.expression.name.text === 'forBuyer'
        ) {
          const arg = n.arguments[1];
          if (
            !arg ||
            ts.isObjectLiteralExpression(arg) ||
            ts.isStringLiteralLike(arg) ||
            ts.isTemplateExpression(arg) ||
            arg.kind === ts.SyntaxKind.NullKeyword
          ) {
            bad.push(
              `${relative(API_SRC, abs)}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`
            );
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    expect(bad).toEqual([]);
  });
});

describe('B2B (review I2): order-creating paths read the entitlement UNCACHED', () => {
  it('every PriceResolver.forBuyer( in order.service passes uncachedEntitlement', () => {
    for (const f of ['services/order.service.ts']) {
      const sf = ts.createSourceFile(f, read(f), ts.ScriptTarget.Latest, true);
      const calls: ts.CallExpression[] = [];
      const visit = (n: ts.Node) => {
        if (ts.isCallExpression(n) && n.expression.getText().endsWith('PriceResolver.forBuyer'))
          calls.push(n);
        ts.forEachChild(n, visit);
      };
      visit(sf);
      expect(calls.length, f).toBeGreaterThan(0);
      for (const c of calls)
        expect(c.arguments[2]?.getText() ?? '', f).toContain('uncachedEntitlement');
    }
  });
});

describe('B2B (M-7, M-3): structural pins on OrderService.create', () => {
  it("the cart is loaded WITHOUT the cart service's own pricing pass (the real buyer prices it once)", () => {
    expect(read('services/order.service.ts')).toMatch(
      /CartService\.getOrCreate\([^)]*skipPricing:\s*true/s
    );
  });
  it('loyalty redemption is capped on the base-priced basis (loyaltyRedeemableSubtotal), not the whole subtotal', () => {
    const src = read('services/order.service.ts');
    expect(src).toMatch(/loyaltyRedeemableSubtotal\(\{/);
    expect(src).not.toMatch(/Math\.max\(0, subtotal - primaryDiscount\)/);
  });
});

describe('B2B: the cart stores quantity only (Ruling B2B-9: a cart price is a quote)', () => {
  it('cart_items has no price column', () => {
    const schema = readFileSync(
      resolve(__dirname, '../../packages/database/prisma/schema.prisma'),
      'utf8'
    );
    const model = schema.match(/^model CartItem \{[\s\S]*?^\}/m)![0];
    expect(model).not.toMatch(/^\s*(price|unitPrice|total)\b/m);
  });

  it('no cart service call writes a price into cart_items', () => {
    const offenders: string[] = [];
    for (const abs of walk(API_SRC)) {
      const sf = ts.createSourceFile(abs, readFileSync(abs, 'utf8'), ts.ScriptTarget.Latest, true);
      const visit = (n: ts.Node) => {
        if (
          ts.isCallExpression(n) &&
          /cartItem\.(create|createMany|update|updateMany|upsert)$/.test(n.expression.getText())
        ) {
          const inner = (m: ts.Node) => {
            if (
              ts.isPropertyAssignment(m) &&
              ['price', 'unitPrice', 'total'].includes(m.name.getText())
            ) {
              offenders.push(
                `${relative(API_SRC, abs)}:${sf.getLineAndCharacterOfPosition(m.getStart()).line + 1}`
              );
            }
            ts.forEachChild(m, inner);
          };
          inner(n);
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    expect(offenders).toEqual([]);
  });
});
