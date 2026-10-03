import { tryToMinor } from '@force/shared';
import { AppError } from '../middleware/error-handler';

/**
 * CSV → platform import CSV.
 *
 * The bulk-import pipeline has ONE importer (`BulkService.importProducts`), fed
 * a "platform CSV" (FWB's own template: prices in integer piastres, variant
 * rows linked by `parentSku`). `xlsx-import.ts` converts spreadsheets into that
 * format; this module does the same for CSV files, so a merchant who uploads a
 * `.csv` goes through exactly the same importer, job row, cache busting and
 * polling endpoint as everyone else — there is no second import system.
 *
 * Two layouts are accepted:
 *
 *  - FWB's own template (`name,price,...`): passed through untouched except for
 *    a leading UTF-8 BOM being stripped. Prices there are INTEGER PIASTRES.
 *  - The Shopify product export (`Handle,Title,Body (HTML),...`): one row per
 *    variant/image, grouped by `Handle`. Prices there are MAJOR EGP ("4,850.00"
 *    is not valid, "4850.00" is) and are parsed with `tryToMinor` — strict, two
 *    decimals max, a third decimal is a row error and is never rounded.
 *
 * Rows that cannot be imported are NOT dropped and do NOT abort the file: they
 * are emitted with an `_error` cell, which the importer reports against the
 * row's ORIGINAL line number (`sourceRow`) — the same per-row behaviour as the
 * rest of the importer (one bad row fails itself, the rest still import).
 *
 * IMAGES: `Image Src` URLs are kept verbatim as remote images (the importer
 * stores them as `product_images.url`). Nothing is fetched here or in the
 * importer. Later ingestion into R2 is a separate, idempotent pass: walk
 * `product_images` / `product_variants.image_url` whose host is not the R2
 * public bucket, download, upload under `<storeId>/products/...`, and rewrite
 * the URL (the existing media pipeline already owns the upload + cache bust).
 */

export type CsvImportFormat = 'shopify' | 'platform';

/** Columns of the platform CSV, in `BulkService.getImportTemplate` order, plus the two import-time meta columns. */
export const PLATFORM_COLUMNS = [
  'name',
  'nameAr',
  'slug',
  'description',
  'descriptionAr',
  'price',
  'compareAtPrice',
  'costPrice',
  'sku',
  'barcode',
  'inventory',
  'lowStockThreshold',
  'trackInventory',
  'weight',
  'status',
  'featured',
  'isNew',
  'categories',
  'tags',
  'images',
  'metaTitle',
  'metaTitleAr',
  'metaDescription',
  'metaDescriptionAr',
  'parentSku',
  'option1Name',
  'option1Value',
  'option2Name',
  'option2Value',
  'option3Name',
  'option3Value',
  // Meta: 1-based record number in the SOURCE file (header = 1), and a
  // pre-import rejection reason. Both are read by BulkService.importProducts.
  'sourceRow',
  '_error',
] as const;

export type PlatformColumn = (typeof PLATFORM_COLUMNS)[number];
export type PlatformRow = Record<PlatformColumn, string>;

export interface CsvConversion {
  format: CsvImportFormat;
  /** The platform CSV text to hand to `BulkService.importProducts`. */
  csv: string;
  /** Converted rows (empty for `platform`, which is passed through as text). */
  rows: PlatformRow[];
  /** Rows rejected during conversion, by source row. Also embedded in `csv` as `_error`. */
  rowErrors: Array<{ row: number; error: string }>;
}

/** Strip a leading UTF-8 byte-order mark (Excel "CSV UTF-8" writes one). */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Decode uploaded CSV bytes. UTF-8 (with or without BOM) is the contract; a
 * UTF-16LE file (Excel "Unicode Text") is also recognised by its BOM.
 */
export function decodeCsvBytes(bytes: Buffer): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return stripBom(bytes.subarray(2).toString('utf16le'));
  }
  return stripBom(bytes.toString('utf8'));
}

/**
 * RFC 4180 record splitter. Quoted fields may contain commas, doubled quotes
 * and newlines. Fully blank records are skipped; `number` is the 1-based
 * position among non-blank records (header = 1), the same numbering the
 * importer's `i + 2` uses.
 */
export function parseCsvRecords(text: string): Array<{ number: number; fields: string[] }> {
  const records: Array<{ number: number; fields: string[] }> = [];
  let field = '';
  let fields: string[] = [];
  let inQuotes = false;
  let number = 0;
  const endRecord = () => {
    fields.push(field);
    field = '';
    if (fields.some(f => f.trim() !== '')) {
      number++;
      records.push({ number, fields });
    }
    fields = [];
  };
  const src = stripBom(text);
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      fields.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      endRecord();
    } else field += ch;
  }
  if (field !== '' || fields.length > 0) endRecord();
  return records;
}

const normHeader = (h: string) =>
  h.normalize('NFKC').replace(/[‎‏﻿]/g, '').trim().toLowerCase().replace(/\s+/g, ' ');

/** Detect the layout from the header row. */
export function detectCsvFormat(headers: string[]): CsvImportFormat {
  const h = new Set(headers.map(normHeader));
  return h.has('handle') && (h.has('title') || h.has('variant price')) ? 'shopify' : 'platform';
}

function csvEscape(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function serialize(rows: PlatformRow[]): string {
  const lines = [PLATFORM_COLUMNS.join(',')];
  for (const r of rows) lines.push(PLATFORM_COLUMNS.map(c => csvEscape(r[c])).join(','));
  return lines.join('\n');
}

const blankRow = (): PlatformRow =>
  Object.fromEntries(PLATFORM_COLUMNS.map(c => [c, ''])) as PlatformRow;

/**
 * Entry point used by the import route. Strips a BOM, detects the layout and
 * converts Shopify exports; FWB-template CSVs pass through.
 */
export function importCsvToPlatformCsv(text: string): CsvConversion {
  const records = parseCsvRecords(text);
  if (records.length === 0) {
    throw new AppError(400, 'INVALID_CSV', 'CSV file is empty');
  }
  const format = detectCsvFormat(records[0].fields);
  if (format === 'platform') {
    return { format, csv: stripBom(text), rows: [], rowErrors: [] };
  }
  const rows = shopifyRecordsToRows(records);
  return {
    format,
    csv: serialize(rows),
    rows,
    rowErrors: rows.filter(r => r._error).map(r => ({ row: Number(r.sourceRow), error: r._error })),
  };
}

// ---------------------------------------------------------------------------
// Shopify layout
// ---------------------------------------------------------------------------

const ARABIC_SCRIPT = /[؀-ۿ]/;

/** Header aliases → logical field. First listed header present wins. */
const SHOPIFY_HEADERS = {
  handle: ['handle'],
  title: ['title'],
  titleAr: ['title (ar)', 'title ar', 'name (ar)', 'name ar', 'arabic title', 'title_ar', 'namear'],
  body: ['body (html)', 'body', 'description'],
  bodyAr: [
    'body (html) (ar)',
    'body (html) ar',
    'body ar',
    'description (ar)',
    'description ar',
    'arabic description',
    'descriptionar',
  ],
  type: ['type'],
  category: ['product category'],
  tags: ['tags'],
  published: ['published'],
  status: ['status'],
  opt1Name: ['option1 name'],
  opt1Value: ['option1 value'],
  opt2Name: ['option2 name'],
  opt2Value: ['option2 value'],
  opt3Name: ['option3 name'],
  opt3Value: ['option3 value'],
  sku: ['variant sku'],
  grams: ['variant grams'],
  tracker: ['variant inventory tracker'],
  qty: ['variant inventory qty'],
  price: ['variant price'],
  compareAt: ['variant compare at price'],
  cost: ['cost per item'],
  barcode: ['variant barcode'],
  imageSrc: ['image src'],
  imagePos: ['image position'],
  variantImage: ['variant image'],
  seoTitle: ['seo title'],
  seoTitleAr: ['seo title (ar)', 'seo title ar'],
  seoDesc: ['seo description'],
  seoDescAr: ['seo description (ar)', 'seo description ar'],
} as const;

type Field = keyof typeof SHOPIFY_HEADERS;

interface VariantCandidate {
  n: number;
  sku: string;
  barcode: string;
  price: number | null;
  compareAt: number | null;
  cost: number | null;
  qty: number;
  tracked: boolean;
  weightKg: string;
  image: string;
  optionValues: [string, string, string];
  error: string | null;
}

/** A merchant-facing image URL, or '' when it is not an http(s) URL. Commas are encoded: the importer splits `images` on ','. */
function cleanImageUrl(raw: string): string {
  const url = raw.trim();
  if (!/^https?:\/\//i.test(url)) return '';
  return url.replace(/,/g, '%2C');
}

function parseMoney(raw: string, label: string): { value: number | null; error: string | null } {
  let text = raw.trim();
  if (text === '') return { value: null, error: null };
  // Spreadsheet-formatted amounts ("4,850.00"): accept ONLY well-formed
  // thousands grouping; "4,85" or "1,2345.00" stay invalid rather than guessed.
  if (/^\d{1,3}(,\d{3})+(\.\d*)?$/.test(text)) text = text.replace(/,/g, '');
  const minor = tryToMinor(text);
  if (minor === null) {
    return {
      value: null,
      error: `${label} "${text}" is not a valid EGP amount (at most 2 decimals, digits only)`,
    };
  }
  if (minor < 0) return { value: null, error: `${label} "${text}" must not be negative` };
  return { value: minor, error: null };
}

export function shopifyRecordsToRows(
  records: Array<{ number: number; fields: string[] }>
): PlatformRow[] {
  const header = records[0].fields.map(normHeader);
  const col = {} as Record<Field, number>;
  for (const key of Object.keys(SHOPIFY_HEADERS) as Field[]) {
    col[key] = -1;
    for (const alias of SHOPIFY_HEADERS[key]) {
      const at = header.indexOf(alias);
      if (at >= 0) {
        col[key] = at;
        break;
      }
    }
  }
  if (col.price < 0) {
    throw new AppError(400, 'INVALID_CSV', 'Shopify CSV is missing the "Variant Price" column');
  }
  const cell = (rec: { fields: string[] }, f: Field): string =>
    col[f] >= 0 ? (rec.fields[col[f]] ?? '').trim() : '';

  // Group rows by handle, first-seen order. A row with no handle cannot be placed.
  const groups = new Map<string, Array<{ number: number; fields: string[] }>>();
  const out: PlatformRow[] = [];
  const reject = (n: number, error: string) => {
    const r = blankRow();
    r.sourceRow = String(n);
    r._error = error;
    out.push(r);
  };
  const orphans: Array<{ n: number; error: string }> = [];
  for (const rec of records.slice(1)) {
    const handle = cell(rec, 'handle').toLowerCase();
    if (!handle) {
      orphans.push({ n: rec.number, error: 'Handle is required (every Shopify row needs one)' });
      continue;
    }
    const list = groups.get(handle) ?? [];
    list.push(rec);
    groups.set(handle, list);
  }

  for (const [handle, rows] of groups) {
    const first = rows[0];
    const firstWith = (f: Field) => rows.map(r => cell(r, f)).find(v => v !== '') ?? '';

    const title = firstWith('title');
    const isVariantRow = (r: { fields: string[] }) =>
      cell(r, 'opt1Value') !== '' || cell(r, 'sku') !== '' || cell(r, 'price') !== '';
    const variantRecs = rows.filter(isVariantRow);

    if (!title) {
      for (const r of rows) {
        reject(
          r.number,
          r === first
            ? `Title is required (product "${handle}")`
            : `Skipped: product "${handle}" has no Title`
        );
      }
      continue;
    }

    // Option axis names live on the product's first row only.
    const optionNames: [string, string, string] = [
      firstWith('opt1Name'),
      firstWith('opt2Name'),
      firstWith('opt3Name'),
    ];
    const isDefaultOnly = (v: string) => v === '' || v.toLowerCase() === 'default title';
    const flat = variantRecs.length <= 1;

    const candidates: VariantCandidate[] = variantRecs.map(r => {
      const errs: string[] = [];
      const price = parseMoney(cell(r, 'price'), 'Variant Price');
      if (price.error) errs.push(price.error);
      else if (price.value === null) errs.push('Variant Price is required');
      const compare = parseMoney(cell(r, 'compareAt'), 'Variant Compare At Price');
      if (compare.error) errs.push(compare.error);
      const cost = parseMoney(cell(r, 'cost'), 'Cost per item');
      if (cost.error) errs.push(cost.error);

      const qtyText = cell(r, 'qty');
      let qty = 0;
      if (qtyText !== '') {
        if (/^-?\d+$/.test(qtyText)) qty = Math.max(0, parseInt(qtyText, 10));
        else errs.push(`Variant Inventory Qty "${qtyText}" must be a whole number`);
      }
      const gramsText = cell(r, 'grams');
      let weightKg = '';
      if (gramsText !== '') {
        if (/^\d+(\.\d+)?$/.test(gramsText)) {
          const kg = Number(gramsText) / 1000;
          weightKg = kg > 0 ? String(kg) : '';
        } else errs.push(`Variant Grams "${gramsText}" must be a number`);
      }

      const optionValues: [string, string, string] = [
        cell(r, 'opt1Value'),
        cell(r, 'opt2Value'),
        cell(r, 'opt3Value'),
      ];
      if (!flat && isDefaultOnly(optionValues[0])) {
        errs.push('Option1 Value is required for a product with several variants');
      }
      return {
        n: r.number,
        sku: cell(r, 'sku'),
        barcode: cell(r, 'barcode'),
        price: price.value,
        compareAt: compare.value,
        cost: cost.value,
        qty,
        tracked: cell(r, 'tracker') !== '',
        weightKg,
        image: cleanImageUrl(cell(r, 'variantImage')),
        optionValues,
        error: errs[0] ?? null,
      };
    });

    const valid = candidates.filter(c => !c.error);
    if (valid.length === 0) {
      // Nothing sellable: every variant row reports its own reason; image-only rows are not rows of their own.
      for (const c of candidates) reject(c.n, c.error ?? 'No valid variant');
      if (candidates.length === 0) reject(first.number, `Product "${handle}" has no variant data`);
      continue;
    }

    // Product-level attributes (first non-empty value across the group's rows).
    const status = (() => {
      const s = firstWith('status').toLowerCase();
      const base = s === 'draft' || s === 'archived' || s === 'active' ? s : 'active';
      return firstWith('published').toLowerCase() === 'false' && base === 'active' ? 'draft' : base;
    })();
    const categoryFallback = firstWith('category')
      .split('>')
      .map(s => s.trim())
      .filter(Boolean)
      .pop();
    const imageEntries = rows
      .map((r, order) => ({
        url: cleanImageUrl(cell(r, 'imageSrc')),
        pos: Number.parseInt(cell(r, 'imagePos'), 10),
        order,
      }))
      .filter(e => e.url);
    imageEntries.sort(
      (a, b) =>
        (Number.isFinite(a.pos) ? a.pos : Infinity) - (Number.isFinite(b.pos) ? b.pos : Infinity) ||
        a.order - b.order
    );
    const images = [...new Set(imageEntries.map(e => e.url))].join(',');

    const titleAr = firstWith('titleAr') || (ARABIC_SCRIPT.test(title) ? title : '');
    const base = blankRow();
    base.name = title;
    base.nameAr = titleAr;
    base.slug = handle;
    base.description = firstWith('body');
    base.descriptionAr = firstWith('bodyAr');
    base.status = status;
    base.featured = 'false';
    base.isNew = 'false';
    base.categories = firstWith('type') || categoryFallback || '';
    base.tags = firstWith('tags')
      .split(',')
      .map(t => t.trim())
      .filter(Boolean)
      .join(',');
    base.images = images;
    base.metaTitle = firstWith('seoTitle');
    base.metaTitleAr = firstWith('seoTitleAr');
    base.metaDescription = firstWith('seoDesc');
    base.metaDescriptionAr = firstWith('seoDescAr');
    base.trackInventory = String(valid.some(v => v.tracked));
    base.sourceRow = String(first.number);

    if (flat) {
      // One variant ("Default Title" or a lone size) = a plain product.
      const v = valid[0];
      base.price = String(v.price);
      if (v.compareAt !== null && v.compareAt > (v.price as number)) {
        base.compareAtPrice = String(v.compareAt);
      }
      if (v.cost !== null) base.costPrice = String(v.cost);
      base.sku = v.sku;
      base.barcode = v.barcode;
      base.inventory = String(v.qty);
      base.weight = v.weightKg;
      out.push(base);
      // A flat product's own row errors can't exist here (valid.length>0 and 1 candidate).
      continue;
    }

    // Variant product: the parent carries no stock (stock = sum of variants);
    // its price is the lowest variant price ("from" price). parentSku links
    // variant rows to it — the Shopify handle is the stable, unique key.
    base.sku = handle;
    base.price = String(Math.min(...valid.map(v => v.price as number)));
    base.inventory = '0';
    out.push(base);

    for (const c of candidates) {
      if (c.error) {
        reject(c.n, c.error);
        continue;
      }
      const vr = blankRow();
      vr.parentSku = handle;
      vr.sku = c.sku;
      vr.barcode = c.barcode;
      vr.price = String(c.price);
      if (c.compareAt !== null && c.compareAt > (c.price as number)) {
        vr.compareAtPrice = String(c.compareAt);
      }
      if (c.cost !== null) vr.costPrice = String(c.cost);
      vr.inventory = String(c.qty);
      vr.weight = c.weightKg;
      vr.images = c.image;
      vr.option1Name = optionNames[0] || 'Option 1';
      vr.option1Value = c.optionValues[0];
      if (c.optionValues[1]) {
        vr.option2Name = optionNames[1] || 'Option 2';
        vr.option2Value = c.optionValues[1];
      }
      if (c.optionValues[2]) {
        vr.option3Name = optionNames[2] || 'Option 3';
        vr.option3Value = c.optionValues[2];
      }
      vr.sourceRow = String(c.n);
      out.push(vr);
    }
  }

  for (const o of orphans) reject(o.n, o.error);
  return out;
}
