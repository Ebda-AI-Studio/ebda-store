import { z } from 'zod';

const httpsUrl = z
  .string()
  .trim()
  .url()
  .refine(u => /^https?:\/\//i.test(u), 'URL must be http(s)')
  .optional()
  .or(z.literal('').transform(() => undefined));

export const locationInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  nameAr: z.string().trim().max(200).optional(),
  country: z.string().trim().min(1).max(100),
  countryAr: z.string().trim().max(100).optional(),
  address: z.string().trim().min(1).max(500),
  addressAr: z.string().trim().max(500).optional(),
  phone: z.string().trim().max(40).optional(),
  whatsapp: z.string().trim().max(40).optional(),
  mapsUrl: httpsUrl,
  mapsEmbedUrl: httpsUrl,
  hours: z.string().trim().max(200).optional(),
  hoursAr: z.string().trim().max(200).optional(),
  isPublished: z.boolean().optional().default(true),
  position: z.number().int().min(0).max(10_000).optional().default(0),
});
export type LocationInput = z.infer<typeof locationInputSchema>;

export function mapsSearchUrl(query: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}
