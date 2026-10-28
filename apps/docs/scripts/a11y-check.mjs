// axe-core gate for docs.ebda.app against the BUILT output (out/) at 390px and 1280px.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runA11y } from '@ebda/site-kit/gates/a11y';

await runA11y({
  root: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'out'),
  name: 'docs',
  pages: [
    '/',
    '/ar/',
    '/getting-started/',
    '/authentication/',
    '/hosts/',
    '/money/',
    '/rate-limits/',
    '/webhooks/',
    '/merchant-webhooks/',
    '/storefront-api/',
    '/merchant-api/',
    '/api-reference/',
    '/search/',
    '/no-such-page/',
    '/ar/no-such-page/',
  ],
});
