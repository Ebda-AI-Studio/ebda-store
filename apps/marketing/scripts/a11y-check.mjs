// Automated accessibility gate for the marketing site: axe-core against the BUILT static
// output (out/), both locales and the legal pages, with and without reduced motion.
// The runner is shared (packages/site-kit); this file only declares what to scan.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runA11y } from '@force/site-kit/gates/a11y';

const pages = [
  '/',
  '/en/',
  '/legal/',
  '/privacy/',
  '/terms/',
  '/en/legal/',
  '/en/privacy/',
  '/en/terms/',
];

await runA11y({
  root: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'out'),
  pages,
  name: 'marketing',
  reducedMotion: ['no-preference', 'reduce'],
});
