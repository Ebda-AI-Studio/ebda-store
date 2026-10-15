import { z } from 'zod';

export const swatchHexSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Use #RRGGBB');

/** Both optional + nullable so the admin can clear either one explicitly. */
export const optionValueSwatchSchema = z.object({
  swatchHex: swatchHexSchema.nullable().optional(),
  swatchImageUrl: z
    .string()
    .max(2048)
    .url()
    // Rendered into <img>/CSS by the storefront: https only (no javascript:, data:, http:).
    .refine(v => {
      // Zod still runs refine after a failed .url(); never throw on a malformed value.
      try {
        return new URL(v).protocol === 'https:';
      } catch {
        return false;
      }
    }, 'Use an https URL')
    .nullable()
    .optional(),
});

export type Swatch = { hex: string | null; imageUrl: string | null };

export function swatchOf(v: {
  swatchHex?: string | null;
  swatchImageUrl?: string | null;
}): Swatch | null {
  const hex = v.swatchHex || null;
  const imageUrl = v.swatchImageUrl || null;
  return hex || imageUrl ? { hex, imageUrl } : null;
}
