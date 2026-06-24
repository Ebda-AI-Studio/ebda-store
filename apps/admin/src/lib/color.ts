/**
 * Color conversion utilities — promoted to @force/shared.
 *
 * This shim re-exports from the shared package so all existing
 * `@/lib/color` import sites continue to work without changes.
 */
export { hexToHsl, hslToHex } from '@force/shared';
