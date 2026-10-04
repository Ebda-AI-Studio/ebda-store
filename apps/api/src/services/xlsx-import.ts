import { loadExcelJS } from '../lib/lazy-modules';
import { AppError } from '../middleware/error-handler';

import { tryToMinor } from '@force/shared';
/**
 * Convert an XLSX buffer into the platform's CSV import format.
 *
 * The sheet's header row is matched against the platform's canonical
 * product columns (English names like `name`, `price`) AND a set of
 * common Arabic synonyms seen in real merchant exports. Columns we
 * can't map are dropped; unmapped "origin", "weight" and similar
 * metadata get folded into the description field instead of lost.
 *
 * Rules:
 *  - Prices in the sheet are human currency (e.g. 1.25 = 1.250 EGP);
 *    we convert to piastres (× 100, strict: max 2 decimals).
 *  - Sequential `#N` style identifiers become `${skuPrefix}-${N}`.
 *  - Arabic columns keep their text (we don't transliterate).
 */
export async function xlsxBufferToImportCsv(
  buffer: Buffer,
  options: {
    skuPrefix?: string;
    defaultInventory?: number;
    defaultStatus?: 'draft' | 'active' | 'archived';
    trackInventory?: boolean;
  } = {}
): Promise<string> {
  const {
    skuPrefix = 'ITEM',
    defaultInventory = 100,
    defaultStatus = 'active',
    trackInventory = false,
  } = options;

  const workbook = new (await loadExcelJS()).Workbook();
  try {
    // exceljs' load signature expects ArrayBuffer-backed data; copy the
    // buffer's view to be explicit so TS is happy across node/undici Buffer types.
    const ab = buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength
    ) as ArrayBuffer;
    await workbook.xlsx.load(ab);
  } catch {
    throw new AppError(400, 'INVALID_XLSX', 'Could not parse the uploaded file as XLSX.');
  }

  const sheet = workbook.worksheets[0];
  if (!sheet) {
    throw new AppError(400, 'EMPTY_XLSX', 'The uploaded file has no sheets.');
  }

  // Find the header row — first row that contains at least two non-empty cells.
  let headerRowNum = 0;
  let headerCells: string[] = [];
  for (let r = 1; r <= Math.min(sheet.rowCount, 20); r++) {
    const row = sheet.getRow(r);
    const cells: string[] = [];
    row.eachCell({ includeEmpty: true }, cell => {
      cells.push(cellText(cell.value));
    });
    const nonEmpty = cells.filter(c => c.trim()).length;
    if (nonEmpty >= 2) {
      headerRowNum = r;
      headerCells = cells.map(c => c.trim());
      break;
    }
  }

  if (!headerRowNum) {
    throw new AppError(400, 'NO_HEADER', 'Could not locate a header row in the sheet.');
  }

  const columnMap = headerCells.map(mapHeader);

  // Collect data rows.
  const outRows: ProductRowOut[] = [];
  for (let r = headerRowNum + 1; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const values: string[] = headerCells.map((_, i) => cellText(row.getCell(i + 1).value));
    // Skip completely empty rows.
    if (values.every(v => !v.trim())) continue;

    const rowOut = rowToProduct(values, columnMap, {
      skuPrefix,
      defaultInventory,
      defaultStatus,
      trackInventory,
    });
    if (rowOut) outRows.push(rowOut);
  }

  if (outRows.length === 0) {
    throw new AppError(400, 'NO_ROWS', 'The sheet has a header but no importable data rows.');
  }

  return buildCsv(outRows);
}

// ---------------------------------------------------------------------------
// Header synonyms — any unfamiliar Arabic/English variant we want to support.
// ---------------------------------------------------------------------------

type CanonicalKey =
  | 'name'
  | 'nameAr'
  | 'slug'
  | 'description'
  | 'descriptionAr'
  | 'price'
  | 'compareAtPrice'
  | 'costPrice'
  | 'sku'
  | 'barcode'
  | 'inventory'
  | 'lowStockThreshold'
  | 'trackInventory'
  | 'weight'
  | 'status'
  | 'featured'
  | 'isNew'
  | 'categories'
  | 'tags'
  | 'images'
  | 'metaTitle'
  | 'metaTitleAr'
  | 'metaDescription'
  | 'metaDescriptionAr'
  // Variant columns (OSOSS-style). A row carrying a parentSku is a variant.
  | 'parentSku'
  | 'option1Name'
  | 'option1Value'
  | 'option2Name'
  | 'option2Value'
  | 'option3Name'
  | 'option3Value'
  // Pseudo-keys that don't map 1:1 — we fold these into description.
  | '_sequenceNumber'
  | '_origin'
  | '_weightText'
  | '_unmapped';

const HEADER_ALIASES: Record<string, CanonicalKey> = {
  // English canonical
  name: 'name',
  namear: 'nameAr',
  'name ar': 'nameAr',
  'arabic name': 'nameAr',
  slug: 'slug',
  description: 'description',
  descriptionar: 'descriptionAr',
  'description ar': 'descriptionAr',
  price: 'price',
  compareatprice: 'compareAtPrice',
  'compare at price': 'compareAtPrice',
  costprice: 'costPrice',
  'cost price': 'costPrice',
  sku: 'sku',
  barcode: 'barcode',
  inventory: 'inventory',
  stock: 'inventory',
  lowstockthreshold: 'lowStockThreshold',
  'low stock threshold': 'lowStockThreshold',
  trackinventory: 'trackInventory',
  'track inventory': 'trackInventory',
  weight: 'weight',
  status: 'status',
  featured: 'featured',
  isnew: 'isNew',
  'is new': 'isNew',
  categories: 'categories',
  category: 'categories',
  group: 'categories',
  tags: 'tags',
  images: 'images',
  image: 'images',
  metatitle: 'metaTitle',
  'meta title': 'metaTitle',
  metatitlear: 'metaTitleAr',
  metadescription: 'metaDescription',
  'meta description': 'metaDescription',
  metadescriptionar: 'metaDescriptionAr',

  // Variant columns (English + OSOSS export header)
  parentsku: 'parentSku',
  'parent sku': 'parentSku',
  parent_sku: 'parentSku',
  option1name: 'option1Name',
  'option1 name': 'option1Name',
  option1value: 'option1Value',
  'option1 value': 'option1Value',
  option2name: 'option2Name',
  'option2 name': 'option2Name',
  option2value: 'option2Value',
  'option2 value': 'option2Value',
  option3name: 'option3Name',
  'option3 name': 'option3Name',
  option3value: 'option3Value',
  'option3 value': 'option3Value',

  // Arabic synonyms (trimmed + lowercased)
  الصنف: 'nameAr',
  'الصنف عربي': 'nameAr',
  الاسم: 'nameAr',
  'الاسم عربي': 'nameAr',
  'اسم المنتج': 'nameAr',
  'الصنف e': 'name',
  'الاسم e': 'name',
  'الاسم بالانجليزية': 'name',
  'اسم المنتج بالانجليزية': 'name',
  الوصف: 'description',
  'الوصف عربي': 'descriptionAr',
  السعر: 'price',
  سعر: 'price',
  'السعر الوحدة': 'price',
  'سعر الوحدة': 'price',
  التكلفة: 'costPrice',
  'سعر التكلفة': 'costPrice',
  الباركود: 'barcode',
  المخزون: 'inventory',
  الكمية: 'inventory',
  مجموعة: 'categories',
  المجموعة: 'categories',
  الفئة: 'categories',
  القسم: 'categories',
  الوسوم: 'tags',
  الصور: 'images',
  الحالة: 'status',
  الرقم: '_sequenceNumber',
  رقم: '_sequenceNumber',
  المنشأ: '_origin',
  'بلد المنشأ': '_origin',
  الوزن: '_weightText',
  'الصنف الأب': 'parentSku',
  'المنتج الأب': 'parentSku',
};

function normaliseHeader(h: string): string {
  return h
    .normalize('NFKC')
    .replace(/[‏‎]/g, '') // strip RTL/LTR marks
    .trim()
    .toLowerCase();
}

function mapHeader(header: string): CanonicalKey {
  const key = normaliseHeader(header);
  if (!key) return '_unmapped';
  return HEADER_ALIASES[key] || '_unmapped';
}

// ---------------------------------------------------------------------------
// Row assembly
// ---------------------------------------------------------------------------

type ProductRowOut = Record<CanonicalKey, string>;

function rowToProduct(
  values: string[],
  columnMap: CanonicalKey[],
  options: {
    skuPrefix: string;
    defaultInventory: number;
    defaultStatus: 'draft' | 'active' | 'archived';
    trackInventory: boolean;
  }
): ProductRowOut | null {
  const raw: Partial<Record<CanonicalKey, string>> = {};
  columnMap.forEach((key, i) => {
    const v = values[i]?.toString().trim();
    if (!v) return;
    // If the same key appears more than once, keep the first non-empty.
    if (!raw[key]) raw[key] = v;
  });

  // A row needs at least a name of some kind to be importable — EXCEPT variant
  // rows (identified by parentSku), which inherit their name from the parent.
  if (!raw.name && !raw.nameAr && !raw.parentSku) return null;

  const out: Partial<ProductRowOut> = { ...raw };

  // Price — convert from human currency (12.50) to piastres (1250). STRICT:
  // more than the currency's decimals ("12.505") is rejected, never rounded —
  // the row gets the sentinel 'NaN', which the bulk validator reports as an
  // invalid price instead of silently importing a mangled amount.
  for (const key of ['price', 'compareAtPrice', 'costPrice'] as const) {
    const cell = raw[key];
    if (!cell) continue;
    const minor = tryToMinor(cell);
    if (minor !== null) {
      out[key] = String(minor);
    } else if (Number.isFinite(parseFloat(cell))) {
      out[key] = 'NaN';
    }
  }

  // SKU — prefer explicit SKU column, otherwise derive from #N sequence.
  if (!out.sku && raw._sequenceNumber) {
    const numMatch = raw._sequenceNumber.match(/\d+/);
    if (numMatch) {
      out.sku = `${options.skuPrefix}-${numMatch[0].padStart(3, '0')}`;
    }
  }

  // Fold origin + weight text into description so the data isn't lost.
  const descExtras: string[] = [];
  if (raw._origin) descExtras.push(`المنشأ: ${raw._origin}`);
  if (raw._weightText) descExtras.push(`الوزن: ${raw._weightText}`);
  if (descExtras.length > 0) {
    const prefix = descExtras.join(' • ');
    out.descriptionAr = out.descriptionAr ? `${prefix}\n${out.descriptionAr}` : prefix;
  }

  // Defaults.
  if (!out.inventory) out.inventory = String(options.defaultInventory);
  if (!out.status) out.status = options.defaultStatus;
  if (out.trackInventory === undefined) out.trackInventory = String(options.trackInventory);

  // Trim whitespace from Arabic text that often has trailing/leading spaces.
  if (out.nameAr) out.nameAr = out.nameAr.trim();
  if (out.name) out.name = out.name.trim();
  if (out.categories) out.categories = out.categories.trim();

  return fillMissing(out);
}

function fillMissing(partial: Partial<ProductRowOut>): ProductRowOut {
  const full = {} as ProductRowOut;
  for (const key of CSV_COLUMNS) {
    full[key] = partial[key] ?? '';
  }
  return full;
}

// ---------------------------------------------------------------------------
// CSV serialisation — matches BulkService.getImportTemplate's header order.
// ---------------------------------------------------------------------------

const CSV_COLUMNS: CanonicalKey[] = [
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
];

function buildCsv(rows: ProductRowOut[]): string {
  const header = CSV_COLUMNS.join(',');
  const body = rows.map(row => CSV_COLUMNS.map(col => csvEscape(row[col] ?? '')).join(','));
  return [header, ...body].join('\n');
}

function csvEscape(value: string): string {
  if (value === '') return '';
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Cell → string coercion
// ---------------------------------------------------------------------------

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value instanceof Date) return value.toISOString();
  // exceljs rich text: { richText: [{ text }] }
  if (typeof value === 'object' && value !== null) {
    const v = value as { richText?: { text: string }[]; result?: unknown; text?: string };
    if (Array.isArray(v.richText)) return v.richText.map(r => r.text || '').join('');
    if (v.result !== undefined) return cellText(v.result);
    if (typeof v.text === 'string') return v.text;
  }
  return String(value);
}
