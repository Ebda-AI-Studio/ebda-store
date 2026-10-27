// Live-search gate for status: types into the header box on the English page (the .gate snapshot serves the
// script and the page data as the Worker does) and expects the component, then the incident; axe on the dropdown.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSearchCheck } from '@ebda/site-kit/gates/search';

await runSearchCheck({
  root: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.gate'),
  name: 'status',
  cases: [],
  typeahead: [
    { page: '/en/', q: 'merch', expect: '/en#c-admin' },
    { page: '/en/', q: 'slow docs', expect: '/en#i-3' },
  ],
});
