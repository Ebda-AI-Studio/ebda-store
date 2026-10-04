// Lighthouse (offline) for help.ebda.app against out/.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLighthouse } from '@force/site-kit/gates/lighthouse';

await runLighthouse({
  root: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'out'),
  name: 'help',
  pages: ['/', '/create-your-store/', '/en/create-your-store/'],
});
