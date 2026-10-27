/**
 * Merchant QR design settings (QR-1). Zod only: no QR library import, so the API can validate
 * the stored shape without pulling the encoder into the Worker bundle (STARTUP-CPU-1).
 * Stored under `Store.settings.qr`; edited at admin `/stores/[id]/qr`.
 */
import { z } from 'zod';
import { validateColours } from './contrast';

export const QR_STYLES = ['square', 'rounded', 'dots'] as const;
export const QR_FINDERS = ['square', 'rounded', 'circle'] as const;
export const QR_FRAMES = ['none', 'card', 'badge'] as const;
export const QR_KINDS = ['store', 'product', 'category', 'whatsapp'] as const;
export const QR_CTA_MAX = 40;

export type QrStyle = (typeof QR_STYLES)[number];
export type QrFinder = (typeof QR_FINDERS)[number];
export type QrFrame = (typeof QR_FRAMES)[number];
export type QrKind = (typeof QR_KINDS)[number];

export const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const hex = z.string().regex(HEX_COLOR);

export const qrDesignSchema = z
  .object({
    style: z.enum(QR_STYLES),
    finder: z.enum(QR_FINDERS),
    frame: z.enum(QR_FRAMES),
    fg: hex,
    bg: hex,
    frameColor: hex,
    cta: z
      .object({
        text: z.string().trim().min(1).max(QR_CTA_MAX),
        lang: z.enum(['ar', 'en']),
      })
      .nullable(),
    logo: z.boolean(),
  })
  .strict()
  // Same rule the page enforces, repeated at the API edge so a direct call cannot store a code
  // that does not scan: dark on light, at least 4.5:1.
  .superRefine((d, ctx) => {
    for (const problem of validateColours(d.fg, d.bg)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['fg'], message: problem });
    }
  });

export type QrDesign = z.infer<typeof qrDesignSchema>;

/** Night ink on white, Ebda brass frame. No orange: merchants may pick any colour themselves. */
export const DEFAULT_QR_DESIGN: QrDesign = {
  style: 'rounded',
  finder: 'rounded',
  frame: 'card',
  fg: '#14110d',
  bg: '#ffffff',
  frameColor: '#b08d57',
  cta: { text: 'امسح وتسوّق', lang: 'ar' },
  logo: false,
};

export const qrSettingsSchema = z
  .object({
    design: qrDesignSchema,
    /** Pre-filled first WhatsApp message for the chat code. */
    whatsappText: z.string().trim().max(200).optional(),
  })
  .strict();

export type QrSettings = z.infer<typeof qrSettingsSchema>;

export const DEFAULT_QR_SETTINGS: QrSettings = { design: DEFAULT_QR_DESIGN };
