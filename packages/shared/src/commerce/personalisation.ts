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

// Invisible / direction-changing characters that a workshop cannot see but that
// change what a name looks like (display + log spoofing):
//   C0/C1 controls, ALM (U+061C), zero-width space/joiners (U+200B-U+200D),
//   LRM/RLM (U+200E/F), line/paragraph separators (U+2028/9), bidi
//   embeddings/overrides (U+202A-U+202E), isolates (U+2066-U+2069), BOM (U+FEFF).
const STRIP =
  /[\u0000-\u001F\u007F-\u009F\u061C\u200B-\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/** Customer note with invisible characters stripped and trimmed, NOT capped; empty → null. */
export function stripNote(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.replace(STRIP, '').trim();
  return s ? s : null;
}

/** Customer note → stored text: stripped, trimmed, capped at 200; empty → null. */
export function cleanNote(raw: unknown): string | null {
  const s = stripNote(raw);
  return s ? s.slice(0, PERSONALISATION_NOTE_MAX) : null;
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
