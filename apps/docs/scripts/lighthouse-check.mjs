// Lighthouse (offline) for docs.ebda.app against out/.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLighthouse } from '@force/site-kit/gates/lighthouse';

await runLighthouse({
  root: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'out'),
  name: 'docs',
  pages: ['/', '/authentication/', '/ar/'],
});
