// Search smoke gate for docs: real queries against the built index, in Chromium.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSearchCheck } from '@force/site-kit/gates/search';

await runSearchCheck({
  root: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'out'),
  name: 'docs',
  cases: [
    { page: '/search/', q: 'piastres', expect: '/money/' },
    { page: '/search/', q: 'x-merchant-key', expect: '/authentication/' },
    { page: '/search/', q: 'signature', expect: '/webhooks/' },
  ],
});
