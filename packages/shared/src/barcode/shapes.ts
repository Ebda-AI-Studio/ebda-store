import { z } from 'zod/v3';
import { BARKOD_SHAPE_DATA } from './shapes.generated';

/** The 24 BARKOD studio shapes Ahmad approved (docs/third-party/barkod-studio.md). */
export const RECEIPT_BARCODE_SHAPES = Object.keys(BARKOD_SHAPE_DATA) as unknown as readonly [
  string,
  ...string[],
];
export type BarcodeShapeId = string;

/** `settings.receiptBarcodeShape`: plain bars (default), off, or a shape id. */
export const receiptBarcodeShapeSchema = z.enum(['plain', 'off', ...RECEIPT_BARCODE_SHAPES] as [
  string,
  ...string[],
]);
export type ReceiptBarcodeShape = z.infer<typeof receiptBarcodeShapeSchema>;
export const DEFAULT_RECEIPT_BARCODE_SHAPE = 'plain';

export const BARCODE_SHAPE_CREDIT = 'Shape drawings by BARKOD studio (barkod.studio).';

export function barcodeShapeData(id: string) {
  return BARKOD_SHAPE_DATA[id];
}
