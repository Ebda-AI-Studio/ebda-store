import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The first template's fragment (public/looks/qamar.html, our own build artefact), read at
 * build time so the section paints without a client fetch. cwd is apps/marketing under
 * `next build` and the repo root under vitest.
 */
export function initialLooksFragment(): string {
  for (const base of ['public', 'apps/marketing/public']) {
    try {
      return readFileSync(path.join(process.cwd(), base, 'looks', 'qamar.html'), 'utf8');
    } catch {
      /* try the next base */
    }
  }
  return '';
}
