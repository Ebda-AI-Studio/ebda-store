/**
 * Color conversion utilities — promoted to @ebda/shared.
 *
 * This shim re-exports from the shared package so all existing
 * `@/lib/color` import sites continue to work without changes.
 */
export { hexToHsl, hslToHex } from '@ebda/shared';
