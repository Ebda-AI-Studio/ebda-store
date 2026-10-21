/**
 * Architecture guard (design review section 7, docs/plans/2026-10-21-b2b-wholesale.md Task 3): after this change a charged
 * or customer-visible unit price is decided in ONE place, `PriceResolver` (and the pure `resolveUnitPrice` under it). Every
 * other read of a `price` / `unitPrice` in apps/api/src is either feeding the resolver, reading a PERSISTED order value,
 * a retail display, a catalogue read, an admin display, a writer, or a bundle base price - and must say so in the
 * allow-list below, with a reason. A new file that reads a price turns this red until someone classifies it.
 *
 * The scan is AST based (TypeScript compiler API), so `p?.price`, destructuring `{ price }` and a Prisma `price: true`
 * select are all caught, not only the `x.price` regex shape.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import ts from 'typescript';
import { scanPriceReads, scanSource } from '../helpers/price-read-scan';

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

const ALLOW: Record<string, { category: Category; reason: string }> = {
  // ── money paths: must route through PriceResolver (asserted below) ──
  'services/cart.service.ts': {
    category: 'resolver-input',
    reason: 'computeTotals feeds item/variant base prices to priceCart',
  },
  'services/order.service.ts': {
    category: 'resolver-input',
    reason: 'create + createAdminOrder feed base prices to priceCart; persisted values elsewhere',
  },
  'routes/payment-links.routes.ts': {
    category: 'resolver-input',
    reason: 'link lines priced via priceCart as an anonymous buyer',
  },
  'routes/promotion.routes.ts': {
    category: 'resolver-input',
    reason: 'preview lines priced via priceCart',
  },
  'routes/wa-bridge.routes.ts': {
    category: 'resolver-input',
    reason: 'WhatsApp cart total via priceCart (anonymous); catalogue lists show retail',
  },
  'services/abandoned-cart.service.ts': {
    category: 'resolver-input',
    reason: 'recovery totals via priceCart for the cart owner',
  },
  'services/price-resolver.service.ts': { category: 'resolver-input', reason: 'the loader itself' },
  'mcp/tools/cart.tools.ts': {
    category: 'resolver-output',
    reason:
      'cartView shows the service-resolved unitPrice (retail fallback for an unavailable line)',
  },
  // ── persisted order values (never re-resolved; RF11) ──
  'lib/payment-line-items.ts': {
    category: 'persisted',
    reason: 'payment-provider line items from OrderItem.price',
  },
  'services/invoice.service.ts': {
    category: 'persisted',
    reason: 'invoice lines from OrderItem snapshots',
  },
  'services/fiscal-document-render.ts': { category: 'persisted', reason: 'fiscal document lines' },
  'services/fiscal-document.service.ts': {
    category: 'persisted',
    reason: 'sale lines from persisted order items',
  },
  'services/return.service.ts': {
    category: 'persisted',
    reason:
      'refund math uses OrderItem.price (RF11); Task 8b adds the tier adjustment from snapshots',
  },
  'services/accounting/backorder.service.ts': {
    category: 'persisted',
    reason: 'backorder lines of persisted orders',
  },
  'services/accounting/posting/partial-return-allocation.ts': {
    category: 'persisted',
    reason: 'allocation over persisted lines',
  },
  'services/email-templates/order-confirmation.ts': {
    category: 'persisted',
    reason: 'renders persisted order items',
  },
  'routes/order.routes.ts': {
    category: 'persisted',
    reason: 'order detail / timeline reads of persisted items',
  },
  'routes/payment-abandonments.routes.ts': {
    category: 'persisted',
    reason: 'reads the persisted order amount / items (verified: no re-pricing)',
  },
  'routes/customers.routes.ts': {
    category: 'persisted',
    reason: 'customer export of persisted order items',
  },
  'services/customer-aggregate.service.ts': {
    category: 'persisted',
    reason: 'aggregates persisted orders',
  },
  'lib/inngest/functions/order-created.ts': {
    category: 'persisted',
    reason: 'email fan-out from persisted items',
  },
  'lib/inngest/functions/order-status-changed.ts': {
    category: 'persisted',
    reason: 'fan-out from persisted items',
  },
  'services/payment-providers/fawry.provider.ts': {
    category: 'persisted',
    reason: 'provider payload from persisted order lines',
  },
  'services/payment-providers/paymob.provider.ts': {
    category: 'persisted',
    reason: 'provider payload from persisted order lines',
  },
  'services/shipping-carrier.service.ts': {
    category: 'persisted',
    reason: 'declared value from persisted lines',
  },
  // ── anonymous retail display ──
  'lib/product-feed.ts': {
    category: 'retail-display',
    reason: 'public feed: retail price, anonymous-safe',
  },
  'lib/wishlist-card.ts': {
    category: 'retail-display',
    reason: 'wishlist card: retail, B2B-9 cards unchanged',
  },
  'mcp/tools/catalog.tools.ts': {
    category: 'retail-display',
    reason: 'MCP catalogue is anonymous',
  },
  'services/recommendation.service.ts': {
    category: 'retail-display',
    reason: 'recommendation select: retail',
  },
  'lib/inngest/functions/product-meta-sync.ts': {
    category: 'retail-display',
    reason: 'SEO/meta uses retail price',
  },
  'lib/inngest/functions/bulk-ai-geo.ts': {
    category: 'retail-display',
    reason: 'AI copy uses retail price',
  },
  'routes/ai.routes.ts': { category: 'retail-display', reason: 'AI prompts use retail price' },
  // ── catalogue / admin ──
  'services/product.service.ts': {
    category: 'catalog-read',
    reason: 'product CRUD + public payload; Task 4/6 add tiers and strip group prices',
  },
  'mcp/tools/admin-read.tools.ts': {
    category: 'admin-display',
    reason: 'merchant read of list price',
  },
  // ── writers ──
  'services/bulk.service.ts': {
    category: 'writer',
    reason: 'bulk price edits / import; Task 4 returns tier-above-base warnings',
  },
  'routes/bulk.routes.ts': { category: 'writer', reason: 'bulk edit route' },
  'services/csv-import.ts': { category: 'writer', reason: 'CSV import' },
  'services/import-preview.ts': { category: 'writer', reason: 'import preview' },
  'services/variant.service.ts': { category: 'writer', reason: 'variant price edits' },
  'routes/product.routes.ts': {
    category: 'writer',
    reason: 'fixed-discount refinement on product write',
  },
  // ── bundles at base (B2B-8) ──
  'services/bundle.service.ts': {
    category: 'bundle-base',
    reason: 'bundle components are priced at base',
  },
  'routes/bundle.routes.ts': { category: 'bundle-base', reason: 'bundle admin lines at base' },
  'lib/cart-pricing.ts': {
    category: 'bundle-base',
    reason: 'retailUnitPrice: the labelled retail helper',
  },
  // ── not a product price ──
  'services/billing/subscription-billing.service.ts': {
    category: 'unrelated',
    reason: 'subscription plan price',
  },
  'services/carriers/bosta.carrier.ts': { category: 'unrelated', reason: 'carrier shipping quote' },
  'lib/ai/eval/criteria.ts': { category: 'unrelated', reason: 'AI eval fixture' },
};

const SELF = new Set(['services/price-resolver.service.ts']);

/**
 * Hit budget per file#symbol for the money paths. These reads feed base prices to the resolver (or show retail in a WhatsApp
 * catalogue). Adding ANOTHER direct price read inside a money path changes the count and turns this red: a reviewer then
 * decides whether the new read belongs in the resolver instead (it almost always does).
 */
const MONEY_PATH_BUDGET: Record<string, number> = {
  'routes/payment-links.routes.ts#<module>': 6,
  'routes/promotion.routes.ts#<module>': 2,
  'routes/wa-bridge.routes.ts#<module>': 13,
  'routes/wa-bridge.routes.ts#bridgeProductSearchPage': 1,
  'routes/wa-bridge.routes.ts#buildCustomerHistory': 3,
  'services/abandoned-cart.service.ts#detectNewAbandonments': 5,
  'services/cart.service.ts#<module>': 1,
  'services/cart.service.ts#computeTotals': 4,
  'services/order.service.ts#create': 7,
  'services/order.service.ts#createAdminOrder': 4,
  'services/price-resolver.service.ts#priceCart': 3,
};

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

describe('B2B: direct price reads are classified (AST scan of apps/api/src)', () => {
  const hits = scanPriceReads(API_SRC);
  const files = [...new Set(hits.map(h => h.file))].sort();

  it('every file that reads a price / unitPrice is in the allow-list with a category and a reason', () => {
    const unlisted = files.filter(f => !ALLOW[f]);
    expect(
      unlisted,
      `Classify these in ALLOW (tests/unit/b2b-no-direct-price-reads.test.ts): ${unlisted.join(', ')}`
    ).toEqual([]);
  });

  it('the allow-list has no stale entries (a file that no longer reads a price must leave the list)', () => {
    const stale = Object.keys(ALLOW).filter(f => !files.includes(f));
    expect(stale).toEqual([]);
  });

  it('every allow-list entry carries a reason', () => {
    for (const [f, v] of Object.entries(ALLOW)) expect(v.reason.length, f).toBeGreaterThan(8);
  });

  it('every money-path file ("resolver-input") actually routes through PriceResolver', () => {
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

  it('the money paths have exactly the pinned number of direct price reads (a new read must be reviewed)', () => {
    const counts: Record<string, number> = {};
    for (const h of hits) {
      if (ALLOW[h.file]?.category !== 'resolver-input') continue;
      const k = `${h.file}#${h.symbol}`;
      counts[k] = (counts[k] ?? 0) + 1;
    }
    expect(counts).toEqual(MONEY_PATH_BUDGET);
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

  it('the scanner itself can fail: it flags a direct product.price read in a fresh file', () => {
    const found = scanSource(
      'services/fake.ts',
      'export const f = (item: any) => item.product?.price * item.quantity;'
    );
    expect(found.map(h => h.kind)).toEqual(['access']);
    expect(scanSource('services/fake.ts', 'const { price } = product;').map(h => h.kind)).toEqual([
      'destructure',
    ]);
    expect(
      scanSource('services/fake.ts', 'prisma.product.findMany({ select: { price: true } });').map(
        h => h.kind
      )
    ).toEqual(['select']);
  });
});

describe('B2B: PriceResolver.forBuyer receives a BuyerIdentity, never a literal or a string', () => {
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
  it('every PriceResolver.forBuyer( in order.service and payment-links passes uncachedEntitlement', () => {
    // KV deletes are eventually consistent across colos, so a just-made downgrade must be read from the database at the
    // moment an order / payment link / admin order is created. (In NODE_ENV=test the feature cache is bypassed, so this
    // is pinned structurally; the behaviour is covered by the I2 case in tests/integration/b2b-price-parity.test.ts.)
    for (const f of ['services/order.service.ts', 'routes/payment-links.routes.ts']) {
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
