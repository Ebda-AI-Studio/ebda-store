/**
 * STOP-only token sets (Ruling B2-2). NOT re-exported from the looks barrel and never imported by
 * runtime code: a STOP shot script imports this file by path. `tests/unit/souq-look-tokens.test.ts`
 * fails if any runtime source reads it.
 */

/**
 * STOP-1 alternative for Night souq (Ruling B2-2, prepared, NOT wired): the same room with brass
 * (#C89B3C, 4.87:1 on the page) kept for CTAs only, pomegranate kept for chips. It is in the
 * orange family's neighbourhood (41 deg), so it ships only if Ahmad picks it at STOP-1. Used by
 * the STOP-1 shot script alone; no runtime code and no registry entry reads it.
 */
export const SOUQ_NIGHT_ALT_BRASS = {
  page: '#0F3B2E',
  surface: '#14503F',
  ink: '#F6F3EA',
  muted: '#B4CDC0',
  primary: '#C89B3C',
  onPrimary: '#10151C',
  accent: '#F57A83',
  onAccent: '#10151C',
  line: '#1E5A48',
} as const;
