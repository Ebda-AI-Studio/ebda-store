// axe-core gate for help.ebda.app against the BUILT output (out/) at 390px and 1280px,
// Arabic (RTL) and English (LTR).
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runA11y } from '@ebda/site-kit/gates/a11y';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const slugs = readdirSync(path.join(root, 'content', 'en'))
  .filter(f => f.endsWith('.mdx'))
  .map(f => f.replace(/\.mdx$/, ''));
const pages = [
  '/',
  '/en/',
  '/search/',
  '/en/search/',
  '/no-such-page/',
  '/en/no-such-page/',
  ...slugs.flatMap(s => [`/${s}/`, `/en/${s}/`]),
];

await runA11y({ root: path.join(root, 'out'), pages, name: 'help' });
