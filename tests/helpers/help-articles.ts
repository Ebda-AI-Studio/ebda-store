/** Published help articles (apps/help/content/{ar,en}/**.mdx) as foundation HelpArticle rows, plus the raw rows the manifest builder takes. */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { toHelpArticle, type HelpArticle } from '../../packages/shared/src/foundation/help-article';
import { REPO_ROOT } from './capability-facts';

const CONTENT = join(REPO_ROOT, 'apps/help/content');

export interface RawArticle {
  lang: 'ar' | 'en';
  path: string;
  raw: string;
}

export function rawArticles(): RawArticle[] {
  const out: RawArticle[] = [];
  const walk = (lang: 'ar' | 'en', dir: string, prefix: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(lang, join(dir, e.name), `${prefix}${e.name}/`);
      else if (e.name.endsWith('.mdx'))
        out.push({
          lang,
          path: `${prefix}${e.name.replace(/\.mdx$/, '')}`,
          raw: readFileSync(join(dir, e.name), 'utf8'),
        });
    }
  };
  for (const lang of ['ar', 'en'] as const) walk(lang, join(CONTENT, lang), '');
  return out;
}

/**
 * Guides under `whatsapp/` are imported from Ebda Chat and link Chat's capability ids; those ids live in the
 * ebda-whatsapp registry and are checked by its own guard, so they are not orphans here. Store ids on them still count.
 */
export const helpArticles = (): HelpArticle[] => {
  const storeIds = new Set(
    readdirSync(join(REPO_ROOT, 'capabilities'))
      .filter(f => f.endsWith('.capability.json'))
      .map(f => f.replace(/\.capability\.json$/, ''))
  );
  return rawArticles().map(a => {
    const h = toHelpArticle(a.path, a.lang, a.raw);
    return a.path.startsWith('whatsapp/')
      ? { ...h, capabilities: h.capabilities.filter(c => storeIds.has(c.id)) }
      : h;
  });
};
