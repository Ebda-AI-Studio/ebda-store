// axe-core gate for status.ebda.app: scans the page HTML rendered from a fixture with an active
// outage (Arabic + English) and an all-clear page, at 390px and 1280px.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runA11y } from '@ebda/site-kit/gates/a11y';

await runA11y({
  root: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.gate'),
  name: 'status',
  pages: ['/', '/en/', '/ok/'],
});
