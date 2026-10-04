// Lighthouse (offline) for the status page snapshot.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLighthouse } from '@force/site-kit/gates/lighthouse';

await runLighthouse({
  root: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.gate'),
  name: 'status',
  pages: ['/', '/en/'],
});
