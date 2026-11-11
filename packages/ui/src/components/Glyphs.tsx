/**
 * Explicit glyphs for characters that look like a number's sign but are not one (SIGN-1 guard).
 * A hand-typed `+ ` / `- ` in JSX text is rejected by tests/unit/signed-number-guard.test.ts; use these instead.
 * A real signed number goes through <SignedNumber> / formatSigned.
 */

/** "+" in a button label ("+ Add item") or a threshold suffix ("5+"). Decorative unless `decorative={false}`. */
export function PlusGlyph({ decorative = true }: { decorative?: boolean }) {
  return <span aria-hidden={decorative || undefined}>+</span>;
}

/** The minus of a disclosure toggle (open state). Decorative. */
export function MinusGlyph() {
  return <span aria-hidden="true">{'−'}</span>;
}

/** Separator between two inline values ("Name – email"); an en dash, never a hyphen. */
export function Sep() {
  return <span aria-hidden="true">{' – '}</span>;
}
