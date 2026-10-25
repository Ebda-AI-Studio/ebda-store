// Template-match (docs/plans/2026-10-25-templates-match-mockups.md): the showrooms' hero photos are the SAME
// photos the Python mock-ups use (apps/marketing/public/looks/img/<code>__hero.webp), uploaded additively to
// R2 at demo/<template>/mock/<code>__hero.webp (the previous hero-<key>.webp objects stay, so this is reversible
// by deleting the mapping below). Only looks that have a mock hero photo appear here.
const MOCK_HERO = {
  jasmine: { apothecary: 'ja', bloom: 'jb', clinic: 'jc' },
  dahab: { worn: 'da', workshop: 'db', giftbox: 'dc' },
  lamma: { table: 'la' },
  qamar: { atelier: 'qa' },
  souq: { night: 'sb' },
};

/** The hero image file (relative to the template's asset base) for a look, falling back to `fallback`. */
export function heroFile(template, key, fallback) {
  const code = MOCK_HERO[template]?.[key];
  return code ? `mock/${code}__hero.webp` : fallback;
}
