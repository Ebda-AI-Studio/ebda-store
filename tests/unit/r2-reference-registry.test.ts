/**
 * The R2 reference registry is the ONE list of columns that decide whether an
 * R2 object is still live (apps/api/src/lib/r2-references.ts). The orphan-audit
 * script (`--apply` deletes), the weekly sweep and the per-URL cleanup all read
 * it. A column missing from it = live files deleted: before this registry none
 * of the three hand-written lists read `Store.pwaSettings`, so every generated
 * PWA icon and favicon looked like an orphan.
 *
 * This file makes the SCHEMA the checklist:
 *   1. every Json column, and every String column whose name is URL-shaped,
 *      is either registered or allowlisted below WITH a reason — a new column
 *      in schema.prisma turns this red until someone decides;
 *   2. every registry entry names a real column with the right physical
 *      table/column (the readers build raw SQL from them) and a kind that
 *      matches its Prisma type;
 *   3. a pwaSettings icon URL counts as referenced by both readers.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  R2_REFERENCE_COLUMNS,
  buildIsReferencedSql,
  collectReferencedR2Keys,
  collectUrlsFromJson,
  urlsInString,
  type R2ReferenceDb,
} from '../../apps/api/src/lib/r2-references';

// ─── schema parsing ──────────────────────────────────────────────────────────

interface SchemaColumn {
  model: string;
  field: string;
  type: 'String' | 'Json';
  list: boolean;
  table: string;
  column: string;
}

function parseSchema(): SchemaColumn[] {
  const src = readFileSync(join(__dirname, '../../packages/database/prisma/schema.prisma'), 'utf8');
  const cols: SchemaColumn[] = [];
  const modelRe = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
  let m: RegExpExecArray | null;
  while ((m = modelRe.exec(src))) {
    const [, model, body] = m;
    const table = body!.match(/@@map\("([^"]+)"\)/)?.[1] ?? model!;
    for (const raw of body!.split('\n')) {
      const line = raw.replace(/\/\/.*$/, '').trim();
      const f = line.match(/^(\w+)\s+(String|Json)(\[\])?(\?)?(\s|$)/);
      if (!f) continue;
      cols.push({
        model: model!,
        field: f[1]!,
        type: f[2] as 'String' | 'Json',
        list: Boolean(f[3]),
        table,
        column: line.match(/@map\("([^"]+)"\)/)?.[1] ?? f[1]!,
      });
    }
  }
  return cols;
}

const SCHEMA = parseSchema();
const id = (c: { model: string; field: string }) => `${c.model}.${c.field}`;

/** A String column with one of these in its name could hold a file URL. */
const URL_SHAPED =
  /(url|image|img|logo|icon|avatar|cover|photo|favicon|file|media|thumb|banner|attach|asset|pdf|video|picture|poster|receipt|evidence|link|href|src|content|body|html|document)/i;

/**
 * Columns the gate flags but that can NEVER hold one of OUR R2 URLs.
 * Every entry needs a reason; an entry that stops matching a flagged schema
 * column, or that is also registered, fails the suite.
 */
const NOT_R2_REFERENCES: Record<string, string> = {
  'CiInsight.evidence':
    'JSON { n, stores, rate, baselineRate, bound, asOf } of a rule-based finding over cohort cells (Ruling CI-9), numbers and a date only, never a URL',
  'OrderItem.goldSnapshot':
    'JSON snapshot of how a gold line was priced (karat, weight, rate id and value, making charge, margin, step, unit price; goldLineSnapshotSchema, Ruling B5-17), never a URL',
  'GoldRate.feedReference':
    "the automatic rate's inputs (spot per ounce, fetched-at, premium bps; Ruling B5-15), never a URL and never a provider name",
  'OrderItem.tierLadder':
    'JSON entitlement snapshot { rungs: [{ minQty, priceMinor, variant, group }], groupPercentMinor } taken at sale time (B2B Task 8b, B2B-17/18), never a URL',
  'InstapayReceipt.extracted':
    'what the AI read off a transfer receipt (amounts, names, references), never a URL; the image is a private-bucket key, not a public R2 URL',
  'StoreTaxDocument.profileId': 'foreign key to store_tax_profiles, never a URL',
  'EtaConnection.address': 'the merchant branch address text for the ETA seller block, never a URL',
  'EtaConnection.signingBridgeUrl':
    'merchant-side signing service endpoint, never one of our uploads',
  'EtaReceipt.receiptNumber': 'the order number used as the ETA receipt number, never a URL',
  'EtaReceipt.lineMap': 'order item ids and quantities for partial returns, no media',
  'EtaReceipt.document': 'the ETA Receipt v1.2 JSON (seller, buyer, lines, totals), no media',
  'FiscalDocument.originalDocumentId': 'id of the invoice a credit note adjusts, never a URL',
  'FiscalDocument.payload':
    'the issued document as data (seller, buyer, lines, totals), no media; immutable by trigger',
  'StoreTaxDocument.fileName': "the uploader's original file name (display only), never a URL",
  'Store.googleMapsUrl': 'Google Maps link typed by the merchant, never an upload',
  'StoreLocation.mapsUrl': 'Google Maps link, never an upload',
  'StoreLocation.mapsEmbedUrl': 'Google Maps embed URL, never an upload',
  'User.acquisition':
    "a merchant's signup attribution (utm_*, fbclid, Meta ids, consent, ip, user agent), never a URL to one of our uploads",
  'Plan.limits': 'plan ceilings and on/off flags (numbers/booleans), no media',
  'Product.dimensions': 'numeric width/height/length/weight object',
  'Product.aiFieldSources': 'per-field AI provenance flags',
  'Product.facts': 'spec rows (name/value text pairs + onCard flag), no media',
  'Product.personalisation': 'PDP text-field config (labels, maxLength, flags), no media',
  'SizeChart.columns': 'size-chart column headers (ar/en text, max 24 chars), no media',
  'SizeChart.rows': 'size-chart cells (text, max 24 chars each), no media',
  'Product.aiBalanceBackup': 'backup of name/description text + aiFieldSources, no media',
  'ProductEmbedding.contentHash': 'md5 hex of the embedded product text (search P1), never a URL',
  'ProductEmbedFailure.contentHash':
    'md5 hex of a product text the embedding model rejected (search P1 quarantine), never a URL',
  'Order.shippingAddress': 'postal address',
  'Order.billingAddress': 'postal address',
  'OrderEvent.metadata': 'status-transition audit metadata',
  'Payment.paymentUrl': 'payment-gateway hosted checkout URL (third-party)',
  'Payment.metadata': 'gateway response metadata',
  'PaymentConfig.credentialHints':
    'non-secret credential display hints (last 4 / public values, keyed fingerprints), no media',
  'PaymentConfig.connectionTest': 'last Test connection result {ok, code, mode, at}, no media',
  'PaymentConfig.settings':
    'non-secret per-provider settings (InstaPay handle/phone/expiry, COD percentage), no media',
  'PaymentEvent.providerPayload': 'raw gateway payload',
  'PaymentEvent.details': 'payment audit details',
  'BillingEvent.raw': 'subscription-billing gateway response payload (card tokens stripped)',
  'BillingEvent.vat': 'Ebda platform VAT snapshot (amounts, rate, mode, TRN, legal name); no URLs',
  'WebhookEvent.payload': 'inbound gateway webhook payload',
  'WebhookEvent.rawBody': 'inbound gateway webhook body',
  'NotificationLog.metadata': 'delivery log metadata',
  'AbandonedCart.recoveredOrderId': 'order id (matched on "cover" in "recovered")',
  'ShippingCarrierConfig.settings': 'carrier API settings',
  'ShippingCarrierConfig.credentialHints': 'non-secret credential display hints (set + last 4)',
  'ShippingCarrierConfig.connectionTest':
    'last Test connection result (ok, code, mode, time, fingerprint)',
  'Shipment.trackingUrl': 'carrier-hosted tracking page',
  'Shipment.labelUrl':
    'carrier-hosted label URL returned by Aramex (and the other carriers), never uploaded to R2',
  'Shipment.pickupAddress': 'postal address',
  'Shipment.deliveryAddress': 'postal address',
  'Shipment.dimensions': 'parcel dimensions',
  'ShipmentPickup.address': 'postal address (the carrier card pickup address)',
  'Shipment.statusHistory': 'carrier status timeline',
  'AffiliateEvent.details': 'affiliate audit details',
  'AuditLog.details': 'audit trail — records past values, must not keep files alive',
  'ShippingZone.areas': 'list of area names',
  'ShippingZone.areasAr': 'list of Arabic area names',
  'Campaign.audience': 'audience filter definition',
  'Review.body': 'customer review text, plain text, no uploads',
  'Review.bodyTranslated': 'machine translation of the review text',
  'Review.spamReasons': 'spam classifier reasons',
  'BulkImportJob.errors': 'import error report',
  'BulkAiJob.errors': 'AI job error report',
  'BulkAiJob.filledProducts': 'AI job result report (product ids/fields)',
  'Supplier.address': 'postal address',
  'Expense.ocrJson': 'OCR text extracted from the receipt (the file itself is receiptImageUrl)',
  'GscDailyMetric.topQueries': 'Search Console query stats',
  'BankStatement.fileName': 'original upload filename only; the statement is parsed, not stored',
  'AnswerEngineCheck.citedUrls': 'third-party URLs an AI answer engine cited',
  'AnswerEngineCheck.competitorUrls': 'third-party competitor URLs',
  'ProductModel.materials': 'material names + indexes extracted from the GLB, no URLs',
  'ProductModel.gltfVariants': 'KHR_materials_variants names, no URLs',
  'WebhookEndpoint.url':
    "the merchant's own https webhook receiver address (a third-party server), never an R2 upload",
  'WebhookDelivery.payload':
    'the signed webhook event JSON (ids, totals, status), no media URLs of ours',
  'ProductModel.stats': 'vertex/mesh/texture counts and extension names, no URLs',
};

const FLAGGED = SCHEMA.filter(c => c.type === 'Json' || URL_SHAPED.test(c.field));
const REGISTERED = new Set(R2_REFERENCE_COLUMNS.map(id));

// ─── 1. the schema is the checklist ─────────────────────────────────────────

describe('R2 reference registry covers the schema', () => {
  it('parses a realistic schema (guards the parser itself)', () => {
    expect(SCHEMA.length).toBeGreaterThan(500);
    expect(SCHEMA.find(c => id(c) === 'Store.pwaSettings')).toMatchObject({
      type: 'Json',
      table: 'stores',
      column: 'pwa_settings',
    });
  });

  it('every Json / URL-shaped String column is registered or allowlisted with a reason', () => {
    const unclassified = FLAGGED.map(id).filter(
      k => !REGISTERED.has(k) && !(k in NOT_R2_REFERENCES)
    );
    expect(
      unclassified,
      'New column(s) that may hold an R2 URL. Add each to R2_REFERENCE_COLUMNS ' +
        '(apps/api/src/lib/r2-references.ts) or, if it can never hold one of our ' +
        'uploads, to NOT_R2_REFERENCES here with a reason.'
    ).toEqual([]);
  });

  it('the allowlist has no stale, duplicate-with-registry or reasonless entries', () => {
    const flagged = new Set(FLAGGED.map(id));
    for (const [k, reason] of Object.entries(NOT_R2_REFERENCES)) {
      expect(flagged.has(k), `${k} is no longer a flagged schema column`).toBe(true);
      expect(REGISTERED.has(k), `${k} is both registered and allowlisted`).toBe(false);
      expect(reason.trim().length, `${k} needs a reason`).toBeGreaterThan(10);
    }
  });
});

// ─── 2. every entry is a real column the raw SQL can address ────────────────

describe('R2 reference registry entries match the schema', () => {
  const bySchemaId = new Map(SCHEMA.map(c => [id(c), c]));

  it.each(R2_REFERENCE_COLUMNS.map(c => [id(c), c] as const))('%s', (_k, entry) => {
    const col = bySchemaId.get(id(entry));
    expect(col, `${id(entry)} does not exist in schema.prisma`).toBeDefined();
    expect(entry.table).toBe(col!.table);
    expect(entry.column).toBe(col!.column);
    expect(col!.list).toBe(false);
    expect(entry.kind === 'json' ? 'Json' : 'String').toBe(col!.type);
    expect(entry.why.trim().length).toBeGreaterThan(5);
    // The collector pages on "id".
    expect(bySchemaId.get(`${entry.model}.id`)?.column).toBe('id');
  });

  it('has no duplicate entries', () => {
    expect(REGISTERED.size).toBe(R2_REFERENCE_COLUMNS.length);
  });
});

// ─── 3. pwaSettings icons count as referenced ───────────────────────────────

const PUBLIC = 'https://pub-test.r2.dev';
const toKey = (url: string) => (url.startsWith(PUBLIC + '/') ? url.slice(PUBLIC.length + 1) : null);

/** An in-memory stand-in for the keyset-paged `SELECT "id", ... FROM "<table>"`. */
function fakeDb(rowsByTable: Record<string, Array<Record<string, unknown>>>): R2ReferenceDb {
  return {
    async $queryRawUnsafe<T>(sql: string, ...values: unknown[]): Promise<T> {
      const table = sql.match(/FROM "([^"]+)"/)![1]!;
      const cursor = String(values[0]);
      const limit = Number(values[1]);
      const rows = (rowsByTable[table] ?? [])
        .filter(r => String(r.id) > cursor)
        .sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1))
        .slice(0, limit);
      return rows as T;
    },
  };
}

describe('Store.pwaSettings icons are referenced (the P1 on PR #1977)', () => {
  const icon = `${PUBLIC}/stores/s1/pwa/icon192-abc123.png`;
  const favicon = `${PUBLIC}/stores/s1/pwa/favicon32-abc123.png`;
  const pwaSettings = { appName: 'Shop', icon192: icon, favicon32: favicon, themeColor: '#fff' };

  it('the collector returns the icon keys from pwa_settings', async () => {
    const keys = await collectReferencedR2Keys({
      run: fn => fn(fakeDb({ stores: [{ id: 's1', pwa_settings: pwaSettings }] })),
      toKey,
    });
    expect(keys.has('stores/s1/pwa/icon192-abc123.png')).toBe(true);
    expect(keys.has('stores/s1/pwa/favicon32-abc123.png')).toBe(true);
  });

  it('the per-URL check searches pwa_settings for the key', () => {
    expect(buildIsReferencedSql()).toContain('position($2::text in "pwa_settings"::text) > 0');
  });

  it('pages through a table larger than one page', async () => {
    const stores = Array.from({ length: 7 }, (_, i) => ({
      id: `s${i}`,
      pwa_settings: { icon192: `${PUBLIC}/stores/s${i}/pwa/icon.png` },
    }));
    const keys = await collectReferencedR2Keys({
      run: fn => fn(fakeDb({ stores })),
      toKey,
      pageSize: 3,
    });
    for (let i = 0; i < 7; i++) expect(keys.has(`stores/s${i}/pwa/icon.png`)).toBe(true);
  });
});

describe('URL extraction errs toward "referenced"', () => {
  it('keeps whole-string URLs and finds URLs embedded in HTML / markdown / prose', () => {
    const html = `<p>see <img src="${PUBLIC}/a.png"> and ![x](${PUBLIC}/b.webp) or ${PUBLIC}/c.jpg.</p>`;
    const urls = urlsInString(html);
    expect(urls).toEqual(
      expect.arrayContaining([`${PUBLIC}/a.png`, `${PUBLIC}/b.webp`, `${PUBLIC}/c.jpg`])
    );
    expect(urlsInString(`${PUBLIC}/d.png?v=2`)).toEqual(
      expect.arrayContaining([`${PUBLIC}/d.png?v=2`, `${PUBLIC}/d.png`])
    );
  });

  it('walks nested JSON', () => {
    expect(collectUrlsFromJson({ a: [{ b: `${PUBLIC}/x.png` }], c: 'plain', d: 3 })).toContain(
      `${PUBLIC}/x.png`
    );
  });
});
