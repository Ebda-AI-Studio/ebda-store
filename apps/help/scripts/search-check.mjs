// Search smoke gate for help: real queries against the built index, in Chromium.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSearchCheck } from '@ebda/site-kit/gates/search';

await runSearchCheck({
  root: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'out'),
  name: 'help',
  cases: [
    { page: '/search/', q: 'دومين', expect: '/custom-domain/' },
    { page: '/search/', q: 'شوبيفاي', expect: '/products-and-csv-import/' },
    { page: '/search/', q: 'واتساب', expect: '/whatsapp-buttons/' },
    { page: '/en/search/', q: 'shopify', expect: '/en/products-and-csv-import/' },
    { page: '/en/search/', q: 'lockout', expect: '/en/account-security/' },
    { page: '/en/search/', q: 'instapay', expect: '/en/instapay/' },
  ],
});
