/** WCAG contrast helpers for QR colours (QR-1). */
function channel(v: number): number {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function luminance(hexColor: string): number {
  const h = hexColor.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Black or white, whichever reads better on `background` (used for the frame label). */
export function readableOn(background: string): '#000000' | '#ffffff' {
  return contrastRatio('#000000', background) >= contrastRatio('#ffffff', background)
    ? '#000000'
    : '#ffffff';
}

export const QR_MIN_CONTRAST = 4.5;

export type DesignProblem = 'low-contrast' | 'inverted';

/**
 * A code must be dark-on-light (many scanners fail light-on-dark) and at least AA (4.5:1).
 * Merchants may pick any colours; we only refuse combinations that stop scanning.
 */
export function validateColours(fg: string, bg: string): DesignProblem[] {
  const problems: DesignProblem[] = [];
  if (luminance(fg) >= luminance(bg)) problems.push('inverted');
  if (contrastRatio(fg, bg) < QR_MIN_CONTRAST) problems.push('low-contrast');
  return problems;
}
