// The no-orange gate (Ruling B2-2), shared by every template's token test (Souq B2, Jasmine B3).
/**
 * Ahmad 2026-10-16: no orange. Hue band 12-50 degrees at colour saturation >= 35% is forbidden.
 * Saturation here is HSV (chroma / max), NOT HSL: HSL saturation of a near-white cream reads
 * 50% for #F6F3EA (45 deg) although its chroma is 5% of its value, i.e. it is paper, not a
 * colour. The plan's own Night ink is that cream, so an HSL gate would flag the page's text.
 * `value` is a hex colour or a bare `H S% L%` triplet.
 *
 * Pale tints (Ruling B2-11 amendment): peach and cream (#FFD9B8, #FBE3B5, #FFE0B2) have HSV
 * saturation 28-30% yet read as orange-family; they are caught by a second rule: in the hue band
 * with HSV saturation >= 12% and HSL lightness < 0.95. The cutoff is justified by measurement:
 * the cream ink #F6F3EA (L 0.94) has saturation 4.9%, a pure paper white; anything with
 * >= 12% chroma at that lightness is visibly tinted. At L >= 0.95 a tint is indistinguishable
 * from white on a screen, so it is left alone.
 */
export const ORANGE_HUE: [number, number] = [12, 50];
const ORANGE_MIN_SAT = 0.35;
const PALE_MIN_SAT = 0.12;
const PALE_MAX_LIGHTNESS = 0.95;
function toRgb(value: string): [number, number, number] {
  const v = value.trim();
  if (v.startsWith('#')) {
    const n = parseInt(v.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const m = v.match(/^([\d.]+)\s+([\d.]+)%\s+([\d.]+)%$/);
  if (!m) throw new Error(`unparseable colour ${value}`);
  const [h, s, l] = [parseFloat(m[1]) / 360, parseFloat(m[2]) / 100, parseFloat(m[3]) / 100];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    t = (t + 1) % 1;
    const c =
      t < 1 / 6
        ? p + (q - p) * 6 * t
        : t < 1 / 2
          ? q
          : t < 2 / 3
            ? p + (q - p) * (2 / 3 - t) * 6
            : p;
    return Math.round(c * 255);
  };
  return s === 0
    ? [Math.round(l * 255), Math.round(l * 255), Math.round(l * 255)]
    : [f(h + 1 / 3), f(h), f(h - 1 / 3)];
}
export function isOrangeFamily(value: string): boolean {
  const [r, g, b] = toRgb(value);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === 0 || max === min) return false;
  const sat = (max - min) / max;
  const d = max - min;
  let hue = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  hue = (hue * 60 + 360) % 360;
  // Ruling B4-2: the hue is rounded to a whole degree first. Terracotta #B5482E measures 11.6
  // degrees, which is 12 by the ruling's own figure ("12 degrees, 59 %") and orange to the eye;
  // the unrounded compare let it through the band's lower edge.
  const inBand = Math.round(hue) >= ORANGE_HUE[0] && Math.round(hue) <= ORANGE_HUE[1];
  const lightness = (max + min) / 2 / 255;
  return (
    inBand && (sat >= ORANGE_MIN_SAT || (sat >= PALE_MIN_SAT && lightness < PALE_MAX_LIGHTNESS))
  );
}
