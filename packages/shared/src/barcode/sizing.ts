import { code128Modules } from './code128';
import { scanCodeFor } from './scan-code';
import { barcodeShapeData } from './shapes';

/** Layout constants shared with the renderer. */
export const BARCODE_PAD = 12; // breathing room around a shape, shape units
export const BARCODE_ZONE = 48; // scan-zone height, shape units
export const BARCODE_QUIET = 10; // Code 128 quiet zone, modules

/**
 * Where a barcode is shown, in CSS px (the width of the barcode box).
 * email: the PNG is 2x this (720px) and shown at this width.
 */
export const BARCODE_DISPLAY_PX = {
  storefrontReceipt: 344, // 24rem paper minus its 20px side padding
  invoice: 360,
  billingReceipt: 344,
  email: 360,
  /** Packing slip: A4 page content / 4x6in label content (the label is narrower, so more shapes fall back to plain). */
  packingSlipA4: 360,
  packingSlipLabel: 320,
} as const;
export type BarcodeSurface = keyof typeof BARCODE_DISPLAY_PX;

/** Ruling BARCODE-4: a module (the narrowest bar) is never narrower than this on screen. Print: 2px at 96dpi ~ 0.53 mm, above the 0.25 mm floor. */
export const MIN_MODULE_CSS_PX = 2;

/** CSS px per module when `value` is drawn in `shape` at `displayPx` wide. */
export function moduleCssPx(value: string, shape: string, displayPx: number): number {
  const modules = code128Modules(scanCodeFor(value)).length + BARCODE_QUIET * 2;
  const data = shape === 'plain' ? undefined : barcodeShapeData(shape);
  const share = data ? data.w / (data.w + BARCODE_PAD * 2) : 1;
  return (displayPx * share) / modules;
}

/**
 * The shape that may actually be printed: `off`/`plain` pass through; a shape
 * whose modules would be under the floor at this size falls back to `plain`.
 */
export function resolveBarcodeShape(shape: string, value: string, displayPx: number): string {
  if (shape === 'off' || shape === 'plain') return shape;
  return meetsModuleFloor(value, shape, displayPx) ? shape : 'plain';
}

/** True when `value` drawn in `shape` at `displayPx` keeps every module at or over the floor. */
export function meetsModuleFloor(value: string, shape: string, displayPx: number): boolean {
  return moduleCssPx(value, shape, displayPx) >= MIN_MODULE_CSS_PX - 1e-9;
}
