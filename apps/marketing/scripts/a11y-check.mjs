// Automated accessibility gate for the marketing site: axe-core against the BUILT static
// output (out/), both locales and the legal pages, with and without reduced motion.
// The runner is shared (packages/site-kit); this file only declares what to scan.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runA11y } from '@ebda/site-kit/gates/a11y';

const pages = [
  '/',
  '/no-such-page/',
  '/en/no-such-page/',
  '/en/',
  '/about/',
  '/en/about/',
  '/legal/',
  '/privacy/',
  '/terms/',
  '/merchant-agreement/',
  '/acceptable-use/',
  '/legal/data-deletion/',
  '/legal/whatsapp-terms/',
  '/legal/whatsapp-privacy/',
  '/legal/whatsapp-dpa/',
  '/en/legal/',
  '/en/privacy/',
  '/en/terms/',
  '/en/merchant-agreement/',
  '/en/acceptable-use/',
  '/en/legal/data-deletion/',
  '/en/legal/whatsapp-terms/',
  '/en/legal/whatsapp-privacy/',
  '/en/legal/whatsapp-dpa/',
];

await runA11y({
  root: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'out'),
  pages,
  name: 'marketing',
  reducedMotion: ['no-preference', 'reduce'],
});
