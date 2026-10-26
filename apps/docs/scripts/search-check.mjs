// Search smoke gate for docs: real queries against the built index, in Chromium.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSearchCheck } from '@ebda/site-kit/gates/search';

await runSearchCheck({
  root: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'out'),
  name: 'docs',
  cases: [
    { page: '/search/', q: 'piastres', expect: '/money/' },
    { page: '/search/', q: 'x-merchant-key', expect: '/authentication/' },
    { page: '/search/', q: 'signature', expect: '/webhooks/' },
  ],
  // Header box, no submit. The Arabic landing page searches the English index too.
  typeahead: [
    { page: '/', q: 'p', expect: '/money/' },
    { page: '/', q: 'piastres', expect: '/money/' },
    { page: '/ar/', q: 'signature', expect: '/webhooks/' },
  ],
});
