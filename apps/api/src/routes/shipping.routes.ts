import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod/v3';
import type ExcelJS from 'exceljs';
import { loadExcelJS } from '../lib/lazy-modules';
import { neutralizeRowObject } from '../lib/exports/xlsx';
import multer from 'multer';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { ShippingService } from '../services/shipping.service';
import { prisma } from '@ebda/database';
import { EGYPT_GOVERNORATES, minorToDecimalString, REGION, BRAND } from '@ebda/shared';
import { parsePriceCell } from '../services/price-cell';
import { tenantContext } from '../middleware/tenant-context';
import { storeDb } from '../lib/repo-factory';

const router = Router();

/** BE:E-5: safety valve on the area-rate lists (the full canonical Egypt template is well under this). */
const AREA_RATES_MAX = 10_000;

// Mounted at the bare '/stores' prefix in routes/index.ts, so Express does
// NOT populate req.params.storeId at the mount level — every route below
// declares its own '/:storeId/...' path. router.param runs AFTER Express
// resolves :storeId for the matched route, so RLS tenant context is set
// correctly here. See F2, docs/plans/2026-07-02-rls-cutover.md.
router.param('storeId', tenantContext);

// Validation schemas
const createShippingZoneSchema = z.object({
  name: z.string().min(1).max(100),
  nameAr: z.string().max(100).optional(),
  areas: z.array(z.string()).min(1),
  areasAr: z.array(z.string()).optional(),
  deliveryFee: z.number().min(0),
  freeShippingThreshold: z.number().min(0).optional(),
  estimatedDays: z.number().int().min(1).optional(),
  estimatedDaysMin: z.number().int().min(1).optional(),
  estimatedDaysMax: z.number().int().min(1).optional(),
  position: z.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
});

const updateShippingZoneSchema = createShippingZoneSchema.partial();

const reorderSchema = z.object({
  zoneIds: z.array(z.string().uuid()),
});

// GET /stores/:storeId/shipping - List all shipping zones
router.get(
  '/:storeId/shipping',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const { page, limit, isActive } = req.query;

      const result = await ShippingService.list(storeId, {
        page: page ? parseInt(page as string) : undefined,
        limit: limit ? parseInt(limit as string) : undefined,
        isActive: isActive === 'true' ? true : isActive === 'false' ? false : undefined,
      });

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }
);

// GET /:storeId/shipping/area-rates — list all area rates for the store.
// MUST be defined before `/:storeId/shipping/:id` or Express matches the
// literal `area-rates` segment as a zone id and 404s (caught by the
// integration test).
router.get(
  '/:storeId/shipping/area-rates',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;

      const rates = await prisma.shippingAreaRate.findMany({
        where: { storeId },
        orderBy: [{ position: 'asc' }, { governorate: 'asc' }, { area: 'asc' }],
        take: AREA_RATES_MAX, // BE:E-5
      });

      res.json({
        success: true,
        data: { rates },
      });
    } catch (error) {
      next(error);
    }
  }
);

// GET /:storeId/shipping/area-rates/export.xlsx — download current area rates
// as an xlsx the merchant can fill in and re-import. If the store has no rates
// yet, exports a TEMPLATE: every canonical Egypt area with an empty fee.
//
// Literal `export.xlsx` segment, placed beside the area-rates list route and
// BEFORE the `/:id` zone route so Express does not match it as a zone id.
router.get(
  '/:storeId/shipping/area-rates/export.xlsx',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;

      const rates = await prisma.shippingAreaRate.findMany({
        where: { storeId },
        orderBy: [{ position: 'asc' }, { governorate: 'asc' }, { area: 'asc' }],
        take: AREA_RATES_MAX, // BE:E-5
      });

      const workbook = new (await loadExcelJS()).Workbook();
      workbook.creator = BRAND.product.nameEn;
      workbook.created = new Date();
      const sheet = workbook.addWorksheet('Area Rates');

      sheet.columns = [
        { header: 'Governorate', key: 'governorate', width: 18 },
        { header: 'Governorate (AR)', key: 'governorateAr', width: 18 },
        { header: 'Area', key: 'area', width: 22 },
        { header: 'Area (AR)', key: 'areaAr', width: 22 },
        { header: 'Delivery Fee (EGP)', key: 'deliveryFee', width: 20 },
        { header: 'Free Shipping Over (EGP)', key: 'freeShippingThreshold', width: 24 },
        { header: 'Active', key: 'isActive', width: 10 },
      ];
      sheet.getRow(1).font = { bold: true };
      sheet.getRow(1).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFF1F5F9' },
      };

      // Fee is stored in piastres → show as EGP with 2 decimals.
      const minorToMajor = (piastres: number) => minorToDecimalString(piastres);

      if (rates.length > 0) {
        for (const r of rates) {
          sheet.addRow(
            neutralizeRowObject({
              governorate: r.governorate,
              governorateAr: r.governorateAr,
              area: r.area,
              areaAr: r.areaAr,
              deliveryFee: minorToMajor(r.deliveryFee),
              freeShippingThreshold:
                r.freeShippingThreshold != null ? minorToMajor(r.freeShippingThreshold) : '',
              isActive: r.isActive ? 'Yes' : 'No',
            })
          );
        }
      } else {
        // Template: every canonical area, empty fee / blank Active so the
        // merchant fills it and re-imports.
        for (const gov of EGYPT_GOVERNORATES) {
          for (const area of gov.areas) {
            sheet.addRow({
              governorate: gov.en,
              governorateAr: gov.ar,
              area: area.en,
              areaAr: area.ar,
              deliveryFee: '',
              freeShippingThreshold: '',
              isActive: '',
            });
          }
        }
      }

      // Build into an in-memory buffer BEFORE writing the response so the
      // tenant tx is not kept open across the slow client download, and so a
      // single `res.send` keeps this response on the BUFFERED lane
      // (middleware/request-transaction.ts): it commits before the bytes go
      // out, instead of escalating to the streaming lane the way a
      // `wb.xlsx.write(res)` would. Mirrors customers export.xlsx.
      const xlsxBuffer = await workbook.xlsx.writeBuffer();

      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      res.setHeader('Content-Disposition', 'attachment; filename="shipping-area-rates.xlsx"');
      res.setHeader('Content-Length', xlsxBuffer.byteLength);
      res.send(Buffer.from(xlsxBuffer));
    } catch (error) {
      next(error);
    }
  }
);

// GET /stores/:storeId/shipping/:id - Get shipping zone by ID
router.get(
  '/:storeId/shipping/:id',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, id } = req.params;

      const zone = await ShippingService.getById(storeId, id);

      res.json({
        success: true,
        data: { zone },
      });
    } catch (error) {
      next(error);
    }
  }
);

// POST /stores/:storeId/shipping - Create shipping zone
router.post(
  '/:storeId/shipping',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const data = createShippingZoneSchema.parse(req.body);

      const zone = await ShippingService.create(storeId, data);

      res.status(201).json({
        success: true,
        data: { zone },
      });
    } catch (error) {
      next(error);
    }
  }
);

// PUT /stores/:storeId/shipping/:id - Update shipping zone
router.put(
  '/:storeId/shipping/:id',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, id } = req.params;
      const data = updateShippingZoneSchema.parse(req.body);

      const zone = await ShippingService.update(storeId, id, data);

      res.json({
        success: true,
        data: { zone },
      });
    } catch (error) {
      next(error);
    }
  }
);

// DELETE /stores/:storeId/shipping/:id - Delete shipping zone
router.delete(
  '/:storeId/shipping/:id',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, id } = req.params;

      await ShippingService.delete(storeId, id);

      res.json({
        success: true,
        data: { message: 'Shipping zone deleted successfully' },
      });
    } catch (error) {
      next(error);
    }
  }
);

// PATCH /stores/:storeId/shipping/:id/toggle - Toggle shipping zone active status
router.patch(
  '/:storeId/shipping/:id/toggle',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, id } = req.params;

      const zone = await ShippingService.toggleActive(storeId, id);

      res.json({
        success: true,
        data: { zone },
      });
    } catch (error) {
      next(error);
    }
  }
);

// PUT /stores/:storeId/shipping/reorder - Reorder shipping zones
router.put(
  '/:storeId/shipping/reorder',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const { zoneIds } = reorderSchema.parse(req.body);

      const result = await ShippingService.reorder(storeId, zoneIds);

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }
);

// ─── Multer: area-rate file upload (xlsx or csv, ≤2MB) ────────────────────

const areaRateUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const name = file.originalname.toLowerCase();
    const ok =
      file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      file.mimetype === 'text/csv' ||
      file.mimetype === 'text/plain' ||
      name.endsWith('.xlsx') ||
      name.endsWith('.csv');
    cb(null, ok);
  },
});

// ─── CSV helpers (quote-aware, mirrors the admin component) ───────────────

function splitCsvRecords(csv: string): string[] {
  const records: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < csv.length; i++) {
    const char = csv[i];
    if (char === '"') {
      if (inQuotes && csv[i + 1] === '"') {
        current += '""';
        i++;
        continue;
      }
      inQuotes = !inQuotes;
      current += char;
    } else if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && csv[i + 1] === '\n') i++;
      records.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  if (current.length > 0) records.push(current);
  return records;
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const next = line[i + 1];
    if (char === '"' && !inQuotes) {
      inQuotes = true;
    } else if (char === '"' && inQuotes) {
      if (next === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = false;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

/** Map a header cell to the internal import field key (case/space-tolerant). */
function headerKey(h: string): string | null {
  const n = h.trim().toLowerCase();
  if (n.startsWith('governorate (ar') || n.startsWith('governorate(ar')) return null;
  if (n.startsWith('governorate')) return 'governorate';
  if (n.startsWith('area (ar') || n.startsWith('area(ar')) return 'areaAr';
  if (n.startsWith('area')) return 'area';
  if (n.startsWith('delivery fee')) return 'deliveryFee';
  if (n.startsWith('free shipping') || n.startsWith('free over')) return 'freeShippingThreshold';
  if (n.startsWith('active')) return 'isActive';
  return null;
}

/** Parse a CSV buffer into raw import row objects. */
function parseCsvBufferToRows(buf: Buffer): Record<string, string>[] {
  const records = splitCsvRecords(buf.toString('utf8')).filter(r => r.trim() !== '');
  if (records.length < 2) return [];
  const headers = parseCsvLine(records[0]).map(headerKey);
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < records.length; i++) {
    const cells = parseCsvLine(records[i]);
    const obj: Record<string, string> = {};
    headers.forEach((key, idx) => {
      if (key) obj[key] = cells[idx] ?? '';
    });
    if (!obj.area) continue;
    rows.push(obj);
  }
  return rows;
}

/** Parse an xlsx buffer into raw import row objects using ExcelJS. */
async function parseXlsxBufferToRows(buf: Buffer): Promise<Record<string, string>[]> {
  const wb = new (await loadExcelJS()).Workbook();
  // ExcelJS expects an ArrayBuffer / Buffer — cast via ArrayBuffer to satisfy
  // strict type constraints across different Node Buffer type declarations.
  await wb.xlsx.load(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
  );
  const sheet = wb.worksheets[0];
  if (!sheet) return [];

  const rows: Record<string, string>[] = [];
  let headers: (string | null)[] = [];
  let headerRowFound = false;

  sheet.eachRow((row, rowNumber) => {
    const cells = row.values as (ExcelJS.CellValue | undefined)[];
    // row.values is 1-indexed — normalise to 0-indexed strings
    const cellStrings: string[] = [];
    for (let i = 1; i < cells.length; i++) {
      const v = cells[i];
      cellStrings.push(v === null || v === undefined ? '' : String(v));
    }

    if (!headerRowFound) {
      // First non-empty row is the header
      if (cellStrings.some(c => c.trim() !== '')) {
        headers = cellStrings.map(headerKey);
        headerRowFound = true;
      }
      return;
    }

    if (cellStrings.every(c => c.trim() === '')) return; // skip blank rows

    const obj: Record<string, string> = {};
    headers.forEach((key, idx) => {
      if (key) obj[key] = (cellStrings[idx] ?? '').trim();
    });
    if (!obj.area) return;
    rows.push(obj);
  });

  return rows;
}

// ─── ShippingAreaRate schemas ──────────────────────────────────────────────

const areaRateSchema = z.object({
  // Country defaults to Egypt so existing Egypt-only payloads keep working;
  // a custom country/province/area is just a row with these set freely.
  country: z.string().min(1).max(60).optional().default(REGION.countryName.en),
  countryAr: z.string().min(1).max(60).optional().default(REGION.countryName.ar),
  governorate: z.string().min(1).max(60),
  governorateAr: z.string().min(1).max(60),
  area: z.string().min(1).max(60),
  areaAr: z.string().min(1).max(60),
  deliveryFee: z.number().int().min(0),
  freeShippingThreshold: z.number().int().min(0).optional().nullable(),
  isActive: z.boolean().optional(),
  position: z.number().int().min(0).optional(),
});

const updateAreaRateSchema = areaRateSchema.partial();

const bulkAreaRateSchema = z.object({ rates: z.array(areaRateSchema).max(300) });

// ─── ShippingAreaRate import (validate + upsert) ───────────────────────────

const AREA_RATE_IMPORT_ROW_LIMIT = 400;

const importRowSchema = z.object({
  governorate: z.string().max(60).optional(),
  area: z.string().min(1).max(60),
  areaAr: z.string().max(60).optional(),
  // EGP value — accept number or string ("1.500"); parsed to piastres server-side.
  deliveryFee: z.union([z.number(), z.string()]).optional(),
  freeShippingThreshold: z.union([z.number(), z.string()]).optional().nullable(),
  isActive: z.union([z.boolean(), z.string()]).optional(),
});

const importAreaRatesSchema = z.object({
  rows: z.array(importRowSchema).max(AREA_RATE_IMPORT_ROW_LIMIT),
  dryRun: z.boolean().optional(),
});

type ImportRow = z.infer<typeof importRowSchema>;

interface ResolvedAreaRate {
  governorate: string;
  governorateAr: string;
  area: string;
  areaAr: string;
  deliveryFee: number; // piastres
  freeShippingThreshold: number | null; // piastres
  isActive: boolean;
}

interface RowError {
  row: number;
  area: string;
  reason: string;
}

/**
 * Parse an EGP value (number | string like "12.50") into integer piastres —
 * the SAME cell rule as the product import (`parsePriceCell`, ruling
 * MONEYB-8): Arabic digits and thousands commas accepted, more than 2
 * decimals rejected, and a three-decimal-style value ("12.500", which an
 * Egyptian reads as twelve thousand five hundred) rejected as ambiguous.
 * Returns null for blank/invalid/negative so callers can flag an error.
 */
export function parseMajorToMinor(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  if (str === '') return null;
  const r = parsePriceCell(str, { required: true, label: 'rate' });
  return r.ok && r.minor !== null && r.minor >= 0 ? r.minor : null;
}

/** Parse a loose truthy/falsy import cell (Yes/No/true/1/blank) → boolean. */
function parseBool(value: unknown, fallback = true): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  const s = String(value).trim().toLowerCase();
  if (s === '') return fallback;
  return ['yes', 'y', 'true', '1', 'active', 'نعم'].includes(s);
}

/**
 * Resolve a raw import row to a canonical area rate using the @ebda/shared
 * Egypt dataset. Matching is case-insensitive on the EN area name, and also
 * accepts the exact AR area name. If a `governorate` is supplied it must match
 * the resolved area's governorate (EN or AR, case-insensitive). Returns either
 * a fully canonical {value} (EN+AR names from the dataset, fee in piastres) or an
 * {error} describing why the row was skipped.
 *
 * Exported for unit testing the area-name → canonical resolution.
 */
export function resolveImportRow(
  row: ImportRow,
  rowNumber: number
): { value: ResolvedAreaRate } | { error: RowError } {
  const rawArea = (row.area ?? '').trim();
  if (!rawArea) {
    return { error: { row: rowNumber, area: rawArea, reason: 'missing area' } };
  }

  const areaLower = rawArea.toLowerCase();

  // Find the governorate + canonical area by EN (case-insensitive) or exact AR.
  let matchedGov: (typeof EGYPT_GOVERNORATES)[number] | undefined;
  let matchedArea: { en: string; ar: string } | undefined;
  for (const gov of EGYPT_GOVERNORATES) {
    const found = gov.areas.find(a => a.en.toLowerCase() === areaLower || a.ar === rawArea);
    if (found) {
      matchedGov = gov;
      matchedArea = found;
      break;
    }
  }

  if (!matchedGov || !matchedArea) {
    return { error: { row: rowNumber, area: rawArea, reason: 'unknown area' } };
  }

  // If a governorate is given, require it to match the resolved one.
  const givenGov = (row.governorate ?? '').trim();
  if (givenGov) {
    const gl = givenGov.toLowerCase();
    if (gl !== matchedGov.en.toLowerCase() && givenGov !== matchedGov.ar) {
      return {
        error: {
          row: rowNumber,
          area: rawArea,
          reason: `governorate mismatch (area is in ${matchedGov.en})`,
        },
      };
    }
  }

  const piastres = parseMajorToMinor(row.deliveryFee);
  if (piastres === null) {
    return { error: { row: rowNumber, area: rawArea, reason: 'invalid delivery fee' } };
  }

  let threshold: number | null = null;
  if (
    row.freeShippingThreshold !== undefined &&
    row.freeShippingThreshold !== null &&
    String(row.freeShippingThreshold).trim() !== ''
  ) {
    const parsedThreshold = parseMajorToMinor(row.freeShippingThreshold);
    if (parsedThreshold === null) {
      return {
        error: { row: rowNumber, area: rawArea, reason: 'invalid free-shipping threshold' },
      };
    }
    threshold = parsedThreshold;
  }

  return {
    value: {
      governorate: matchedGov.en,
      governorateAr: matchedGov.ar,
      area: matchedArea.en,
      areaAr: matchedArea.ar,
      deliveryFee: piastres,
      freeShippingThreshold: threshold,
      isActive: parseBool(row.isActive, true),
    },
  };
}

// ─── ShippingAreaRate authed CRUD ──────────────────────────────────────────
// (GET list lives above the `/:id` zone route to avoid the route-shadowing 404.)

// PUT /:storeId/shipping/area-rates/bulk — upsert all area rates (admin "save all")
router.put(
  '/:storeId/shipping/area-rates/bulk',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const { rates } = bulkAreaRateSchema.parse(req.body);

      await prisma.$transaction(
        rates.map(rate =>
          prisma.shippingAreaRate.upsert({
            where: {
              storeId_country_governorate_area: {
                storeId,
                country: rate.country,
                governorate: rate.governorate,
                area: rate.area,
              },
            },
            create: {
              storeId,
              country: rate.country,
              countryAr: rate.countryAr,
              governorate: rate.governorate,
              governorateAr: rate.governorateAr,
              area: rate.area,
              areaAr: rate.areaAr,
              deliveryFee: rate.deliveryFee,
              freeShippingThreshold: rate.freeShippingThreshold ?? null,
              isActive: rate.isActive ?? true,
              position: rate.position ?? 0,
            },
            update: {
              countryAr: rate.countryAr,
              governorateAr: rate.governorateAr,
              areaAr: rate.areaAr,
              deliveryFee: rate.deliveryFee,
              freeShippingThreshold: rate.freeShippingThreshold ?? null,
              isActive: rate.isActive ?? true,
              position: rate.position ?? 0,
            },
          })
        )
      );

      const rates_result = await prisma.shippingAreaRate.findMany({
        where: { storeId },
        orderBy: [{ position: 'asc' }, { governorate: 'asc' }, { area: 'asc' }],
        take: AREA_RATES_MAX, // BE:E-5
      });

      res.json({
        success: true,
        data: { rates: rates_result },
      });
    } catch (error) {
      next(error);
    }
  }
);

// POST /:storeId/shipping/area-rates/import — validate rows (from an uploaded
// CSV/xlsx file OR a JSON body) and bulk-upsert. With dryRun=true returns a
// preview WITHOUT writing. Rows resolve to canonical Egypt areas; fees are
// EGP → piastres. Same upsert key (storeId, governorate, area) as the bulk PUT.
//
// Two call shapes (both produce the same response):
//   (a) multipart/form-data: file=<xlsx|csv>, dryRun=<true|false>  ← admin now uses this
//   (b) application/json:    { rows: [...], dryRun: true|false }    ← backward-compat
router.post(
  '/:storeId/shipping/area-rates/import',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  areaRateUpload.single('file'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;

      let rows: ImportRow[];
      let dryRun: boolean;

      if (req.file) {
        // ── Multipart upload path (xlsx or csv) ──────────────────────────
        const name = req.file.originalname.toLowerCase();
        const isXlsx =
          req.file.mimetype ===
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
          name.endsWith('.xlsx');

        let rawRows: Record<string, string>[];
        try {
          rawRows = isXlsx
            ? await parseXlsxBufferToRows(req.file.buffer)
            : parseCsvBufferToRows(req.file.buffer);
        } catch {
          res.status(422).json({
            success: false,
            error: { code: 'PARSE_ERROR', message: 'Could not parse the uploaded file.' },
          });
          return;
        }

        if (rawRows.length === 0) {
          res.status(422).json({
            success: false,
            error: { code: 'NO_ROWS', message: 'No rows found in that file.' },
          });
          return;
        }

        // Validate row count cap
        if (rawRows.length > AREA_RATE_IMPORT_ROW_LIMIT) {
          res.status(422).json({
            success: false,
            error: {
              code: 'TOO_MANY_ROWS',
              message: `Too many rows (max ${AREA_RATE_IMPORT_ROW_LIMIT}).`,
            },
          });
          return;
        }

        // Validate each raw row through the import row schema
        rows = rawRows.map(r => importRowSchema.parse(r));
        // dryRun form field comes as a string
        const drField = req.body?.dryRun;
        dryRun = drField === 'true' || drField === true;
      } else {
        // ── JSON body path (backward-compat) ─────────────────────────────
        const parsed = importAreaRatesSchema.parse(req.body);
        rows = parsed.rows;
        dryRun = parsed.dryRun ?? false;
      }

      const resolved: ResolvedAreaRate[] = [];
      const errors: RowError[] = [];

      rows.forEach((row, idx) => {
        const result = resolveImportRow(row, idx + 1);
        if ('error' in result) {
          errors.push(result.error);
        } else {
          resolved.push(result.value);
        }
      });

      // De-dupe on (governorate, area) — last row wins — so the upsert
      // transaction never hits the same unique key twice.
      const byKey = new Map<string, ResolvedAreaRate>();
      for (const r of resolved) {
        byKey.set(`${r.governorate}||${r.area}`, r);
      }
      const toUpsert = Array.from(byKey.values());

      if (dryRun) {
        res.json({
          success: true,
          data: {
            valid: toUpsert.map(r => ({
              governorate: r.governorate,
              area: r.area,
              deliveryFee: r.deliveryFee,
              freeShippingThreshold: r.freeShippingThreshold,
              isActive: r.isActive,
            })),
            errors,
            wouldUpsert: toUpsert.length,
          },
        });
        return;
      }

      if (toUpsert.length > 0) {
        await prisma.$transaction(
          toUpsert.map((rate, position) =>
            prisma.shippingAreaRate.upsert({
              where: {
                storeId_country_governorate_area: {
                  storeId,
                  // Import is Egypt-only today; the column default keeps the key stable.
                  country: REGION.countryName.en,
                  governorate: rate.governorate,
                  area: rate.area,
                },
              },
              create: {
                storeId,
                country: REGION.countryName.en,
                countryAr: REGION.countryName.ar,
                governorate: rate.governorate,
                governorateAr: rate.governorateAr,
                area: rate.area,
                areaAr: rate.areaAr,
                deliveryFee: rate.deliveryFee,
                freeShippingThreshold: rate.freeShippingThreshold,
                isActive: rate.isActive,
                position,
              },
              update: {
                governorateAr: rate.governorateAr,
                areaAr: rate.areaAr,
                deliveryFee: rate.deliveryFee,
                freeShippingThreshold: rate.freeShippingThreshold,
                isActive: rate.isActive,
              },
            })
          )
        );
      }

      res.json({
        success: true,
        data: { upserted: toUpsert.length, errors },
      });
    } catch (error) {
      next(error);
    }
  }
);

// PATCH /:storeId/shipping/area-rates/:id — partial update a single area rate
router.patch(
  '/:storeId/shipping/area-rates/:id',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, id } = req.params;
      const data = updateAreaRateSchema.parse(req.body);

      const rate = await prisma.shippingAreaRate.updateMany({
        where: { id, storeId },
        data,
      });

      if (rate.count === 0) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Area rate not found' },
        });
        return;
      }

      const updated = await prisma.shippingAreaRate.findFirst({
        where: { id, storeId },
      });

      res.json({
        success: true,
        data: { rate: updated },
      });
    } catch (error) {
      next(error);
    }
  }
);

// DELETE /:storeId/shipping/area-rates/:id — delete a single area rate
router.delete(
  '/:storeId/shipping/area-rates/:id',
  authenticate,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId, id } = req.params;

      const deleted = await prisma.shippingAreaRate.deleteMany({
        where: { id, storeId },
      });

      if (deleted.count === 0) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Area rate not found' },
        });
        return;
      }

      res.json({
        success: true,
        data: { message: 'Area rate deleted successfully' },
      });
    } catch (error) {
      next(error);
    }
  }
);

// Public endpoint: Get shipping zones for storefront
// GET /public/:storeId/shipping
router.get('/public/:storeId/shipping', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { storeId } = req.params;

    const zones = await ShippingService.getPublicZones(storeId);

    res.json({
      success: true,
      data: { zones },
    });
  } catch (error) {
    next(error);
  }
});

// Public endpoint: Calculate shipping cost
// POST /public/:storeId/shipping/calculate
router.post(
  '/public/:storeId/shipping/calculate',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;
      const calcSchema = z.object({
        area: z.string().trim().min(1).max(150),
        orderTotal: z.number().int().min(0).optional().default(0),
        governorate: z.string().trim().max(60).optional().default(''),
      });
      const parsed = calcSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: { code: 'MISSING_AREA', message: 'Delivery area is required' },
        });
        return;
      }
      const { area, orderTotal, governorate } = parsed.data;

      const result = await ShippingService.calculateShipping(
        storeId,
        area,
        orderTotal,
        governorate || undefined
      );

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }
);

// Public endpoint: Get area rates for storefront (active only, no sensitive fields)
// GET /public/:storeId/shipping/area-rates
router.get(
  '/public/:storeId/shipping/area-rates',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { storeId } = req.params;

      const rates = await (
        await storeDb(storeId)
      ).shippingAreaRate.findMany({
        where: { storeId, isActive: true },
        orderBy: [{ position: 'asc' }, { governorate: 'asc' }, { area: 'asc' }],
        take: AREA_RATES_MAX, // BE:E-5
        select: {
          governorate: true,
          governorateAr: true,
          area: true,
          areaAr: true,
          deliveryFee: true,
          freeShippingThreshold: true,
        },
      });

      res.json({
        success: true,
        data: { rates },
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
