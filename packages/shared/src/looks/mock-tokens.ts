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
}

const T = (t: MockTokens): MockTokens => t;

/** Only looks whose mock-up differs from the real store appear here. */
export const MOCK_TOKENS: Readonly<Partial<Record<LookId, MockTokens>>> = {
  'qamar.atelier': T({ heroAspect: '3 / 4' }),
  'qamar.vitrine': T({ heroAspect: '4 / 4.6' }),
  'souq.night': T({ heroAspect: '1 / 1.05' }),
  'jasmine.bloom': T({ heroAspect: '4 / 4.4' }),
  'lamma.table': T({ heroAspect: '1 / 1' }),
  'dahab.worn': T({ heroAspect: '4 / 5' }),
  'dahab.workshop': T({ heroAspect: '4 / 3.4' }),
  'dahab.giftbox': T({ heroAspect: '16 / 11' }),
};

export function mockTokensFor(lookId: string | null | undefined): MockTokens {
  return (lookId && MOCK_TOKENS[lookId as LookId]) || {};
}

/** Ratio of each merchant `heroRatio` pick; `wide` is the pre-mock landscape crop (no look variable at all). */
const HERO_RATIO_ASPECT = { tall: '4 / 5', square: '1 / 1' } as const;

/**
 * The `--look-*` CSS variables of a look's mock tokens, after the merchant's overrides (TEMPLATES-MOCK-3):
 * merchant > look > skin. Empty for a look with none.
 */
export function mockCssVars(
  lookId: string | null | undefined,
  theme?: { heroRatio?: string } | null
): Record<string, string> {
  const t = mockTokensFor(lookId);
  const v: Record<string, string> = {};
  const pick = theme?.heroRatio;
  const aspect =
    pick === 'wide'
      ? undefined
      : pick === 'tall' || pick === 'square'
        ? HERO_RATIO_ASPECT[pick]
        : t.heroAspect;
  if (aspect) {
    v['--look-hero-aspect'] = aspect;
    // A portrait hero is taller than 45vh on a phone: lift the ceiling for looks that set a ratio.
    v['--look-hero-maxh'] = 'none';
  }
  return v;
}
