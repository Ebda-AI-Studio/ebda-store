// Lighthouse for the marketing site against out/ (shared runner: packages/site-kit).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLighthouse } from '@ebda/site-kit/gates/lighthouse';

await runLighthouse({
  root: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'out'),
  pages: ['/', '/en/', '/store/', '/en/store/'],
  name: 'marketing',
});
