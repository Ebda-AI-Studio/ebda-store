// 404 search gate for the marketing site: types into the 404 box (no submit), checks the HTTP status is a real
// 404, the dropdown lists the expected page from the shipped index, and axe on the OPEN dropdown. Help and docs
// sources are cross-origin and unreachable offline; the same-origin marketing index must still answer.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSearchCheck } from '@ebda/site-kit/gates/search';

await runSearchCheck({
  root: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'out'),
  name: 'marketing',
  cases: [],
  typeahead: [
    { page: '/no-such-page/', q: 'م', expect: '/features/', status: 404, input: '#q-ar' },
    { page: '/no-such-page/', q: 'المميزات', expect: '/features/', status: 404, input: '#q-ar' },
    {
      page: '/en/no-such-page/',
      q: 'features',
      expect: '/en/features/',
      status: 404,
      input: '#q-en',
    },
    // the header search (icon -> panel), on a normal page
    { page: '/', q: 'المميزات', expect: '/features/', input: '#hs-q-ar', click: '.hs-btn' },
    { page: '/en/', q: 'features', expect: '/en/features/', input: '#hs-q-en', click: '.hs-btn' },
  ],
});
