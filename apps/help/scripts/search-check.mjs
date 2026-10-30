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
    { page: '/search/', q: 'المحفظة', expect: '/whatsapp/wallet-top-ups-and-refunds/' },
    { page: '/en/search/', q: 'wallet', expect: '/en/whatsapp/wallet-top-ups-and-refunds/' },
    {
      page: '/en/search/',
      q: '24-hour window',
      expect: '/en/whatsapp/templates-and-the-24-hour-window/',
    },
  ],
  // Header box, no submit: ONE Arabic letter already lists articles (the index is per locale).
  typeahead: [
    { page: '/', q: 'د', expect: '/custom-domain/' },
    { page: '/', q: 'دومين', expect: '/custom-domain/' },
    { page: '/en/', q: 'insta', expect: '/en/instapay/' },
    { page: '/en/', q: 'shopify', expect: '/en/products-and-csv-import/' },
    { page: '/no-such-page/', q: 'د', expect: '/custom-domain/', status: 404 },
    { page: '/en/no-such-page/', q: 'insta', expect: '/en/instapay/', status: 404 },
  ],
});
