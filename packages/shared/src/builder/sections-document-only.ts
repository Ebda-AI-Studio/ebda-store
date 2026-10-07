/**
 * Section types that exist ONLY in the page document (visual builder
 * Phase 2): they have no key in the legacy `stores.layout_settings`, so the
 * adapter never projects them and the storefront renders them straight from
 * the published `PageDefinition`. Their validators live here (strict Zod);
 * their settings descriptors are in the registry.
 */
import { z } from 'zod';
import { colorValue, sectionPaddingMaxWidthVisibility } from './layout-schema';
import { isSafeUrl } from '../utils/safe-url';

const text = (max: number) => z.string().max(max).optional();
const safeLink = z
  .string()
  .max(2048)
  .optional()
  .refine(v => v === undefined || v === '' || isSafeUrl(v), {
    message: 'Link must be a relative path or use http(s)/mailto/tel',
  });

/** Shared by both: visibility (from the adapter projection) + spacing + background. */
const frame = {
  enabled: z.boolean().optional(),
  bgColor: colorValue,
  ...sectionPaddingMaxWidthVisibility,
};

export const imageTextSchema = z
  .object({
    ...frame,
    image: z.string().max(2048).optional(),
    imageAr: z.string().max(2048).optional(),
    alt: text(300),
    altAr: text(300),
    heading: text(200),
    headingAr: text(200),
    body: text(2000),
    bodyAr: text(2000),
    buttonText: text(60),
    buttonTextAr: text(60),
    buttonLink: safeLink,
    // Logical, never left/right: `start` mirrors to the right in Arabic.
    imagePosition: z.enum(['start', 'end']).optional(),
    imageAspect: z.enum(['square', 'portrait', 'landscape']).optional(),
  })
  .strict();

export const newsletterSchema = z
  .object({
    ...frame,
    heading: text(200),
    headingAr: text(200),
    body: text(600),
    bodyAr: text(600),
    buttonText: text(40),
    buttonTextAr: text(40),
  })
  .strict();
