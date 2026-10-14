import { z } from 'zod';

/** Hard cap on a personalisation note, whatever the merchant's maxLength says. */
export const PERSONALISATION_NOTE_MAX = 200;

export const personalisationConfigSchema = z
  .object({
    enabled: z.boolean(),
    label: z.string().trim().max(60).default(''),
    labelAr: z.string().trim().max(60).default(''),
    maxLength: z.number().int().min(1).max(PERSONALISATION_NOTE_MAX),
    required: z.boolean().default(false),
  })
  .refine(c => !c.enabled || c.label || c.labelAr, { message: 'Label needed' });

export type PersonalisationConfig = z.infer<typeof personalisationConfigSchema>;

// C0/C1 controls + bidi embedding/override/isolate chars (log/display spoofing).
// eslint-disable-next-line no-control-regex
const STRIP = /[\u0000-\u001F\u007F-\u009F‪-‮⁦-⁩]/g;

/** Customer note → stored text: stripped, trimmed, capped at 200; empty → null. */
export function cleanNote(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.replace(STRIP, '').trim().slice(0, PERSONALISATION_NOTE_MAX);
  return s ? s : null;
}

/** Active-language field label; falls back to the other language, never blank. */
export function personalisationLabel(c: PersonalisationConfig, lang: 'ar' | 'en'): string {
  return lang === 'ar' ? c.labelAr || c.label : c.label || c.labelAr;
}

/** A product's stored config, or null when it is absent, malformed or switched off. */
export function activePersonalisation(raw: unknown): PersonalisationConfig | null {
  if (raw == null) return null;
  const parsed = personalisationConfigSchema.safeParse(raw);
  return parsed.success && parsed.data.enabled ? parsed.data : null;
}
