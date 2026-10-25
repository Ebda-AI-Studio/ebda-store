import { LOOK_FONT_SPECS } from './fonts';
import { getLook } from './registry';
import type { LookId } from './types';

/**
 * Template-match tokens (docs/plans/2026-10-25-templates-match-mockups.md): the numbers the Python mock-ups set
 * (apps/marketing/scripts/looks/*.py) that the real templates did not. Each is emitted as a `--look-*` CSS
 * variable on :root for a store on that look (lookCssVars), and every consumer reads it with the old value as the
 * `var()` fallback, so a store with no look, or a look that does not set one, renders byte-for-byte as before.
 * Values are the mock's own, ratios not pixels (the mock is drawn at 360 px, the real store at 390).
 */
export interface MockTokens {
  /** PR2. Mobile hero box `w / h` (replaces the shared 4:3-ish landscape crop and its 45vh ceiling). */
  heroAspect?: string;
  /** PR4 (G5). Section heading size in px on a phone (the weight follows the display face, see `headingWeight`). */
  headingSize?: number;
}

const T = (t: MockTokens): MockTokens => t;

/** One entry per built look: the mock-up's own numbers. */
export const MOCK_TOKENS: Readonly<Partial<Record<LookId, MockTokens>>> = {
  'qamar.atelier': T({ heroAspect: '3 / 4', headingSize: 28 }),
  'qamar.lookbook': T({ headingSize: 28 }),
  'qamar.vitrine': T({ heroAspect: '4 / 4.6', headingSize: 30 }),
  'souq.catalogue': T({ headingSize: 20 }),
  'souq.night': T({ heroAspect: '1 / 1.05', headingSize: 26 }),
  'souq.showroom': T({ headingSize: 30 }),
  'jasmine.apothecary': T({ headingSize: 28 }),
  'jasmine.bloom': T({ heroAspect: '4 / 4.4', headingSize: 28 }),
  'jasmine.clinic': T({ headingSize: 25 }),
  'lamma.table': T({ heroAspect: '1 / 1', headingSize: 30 }),
  'lamma.notebook': T({ headingSize: 30 }),
  'lamma.market': T({ headingSize: 22 }),
  'dahab.worn': T({ heroAspect: '4 / 5', headingSize: 28 }),
  'dahab.workshop': T({ heroAspect: '4 / 3.4', headingSize: 34 }),
  'dahab.giftbox': T({ heroAspect: '16 / 11', headingSize: 30 }),
};

export function mockTokensFor(lookId: string | null | undefined): MockTokens {
  return (lookId && MOCK_TOKENS[lookId as LookId]) || {};
}

/**
 * The heading weight a look's display face really ships: the heaviest of its loaded weights up to 700, else its only
 * weight (Lalezar, Italiana: 400). Asking for a weight the face lacks would make the browser fake-bold it.
 */
export function headingWeight(lookId: string): number {
  const display = getLook(lookId)?.tokens.fonts.display ?? '';
  const spec = LOOK_FONT_SPECS[display] ?? '';
  const ws = (spec.split('@')[1] ?? '').split(';').map(Number).filter(Boolean);
  if (ws.length === 0) return 400;
  const ok = ws.filter(w => w <= 700);
  return ok.length ? Math.max(...ok) : Math.min(...ws);
}

/** The CSS variables of a look's mock tokens (the slim tab bar for every look, plus its own). Callers pass a registered look. */
export function mockCssVars(lookId: string | null | undefined): Record<string, string> {
  if (!getLook(lookId)) return {};
  const t = mockTokensFor(lookId);
  // PR3 (G4): every look keeps the bottom tab bar (the only mobile cart entry for a real store) but slim:
  // 57 px against 76, a 28 px icon well, 4 px padding. The label stays 12 px and the targets stay 56 px tall.
  const v: Record<string, string> = {
    '--bottom-tab-h': '57px',
    '--look-tab-pad': '0.25rem',
    '--look-tab-icon': '1.75rem',
  };
  // PR4 (G5): hierarchy on a phone. Card text is the mock's 13/500 name and 14/700 price, drawn at 360 px.
  v['--look-h-size'] = `${t.headingSize ?? 28}px`;
  v['--look-h-weight'] = String(headingWeight(lookId as string));
  v['--look-name-size'] = '0.875rem';
  v['--look-name-weight'] = '500';
  v['--look-price-size'] = '0.9375rem';
  v['--look-price-weight'] = '700';
  if (t.heroAspect) {
    v['--look-hero-aspect'] = t.heroAspect;
    // A portrait hero is taller than 45vh on a phone: lift the ceiling for looks that set a ratio.
    v['--look-hero-maxh'] = 'none';
  }
  return v;
}
