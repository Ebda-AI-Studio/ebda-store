// help-manifest.json: one row per published article and language, with the capabilities it documents.
// Published at https://help.ebda.app/help-manifest.json. Readers: the product guard tests and the publication-lag check
// (a source guide whose contentHash differs from the published row for more than 48 hours is an alert).
import { createHash } from 'node:crypto';
import { toHelpArticle } from '../../../packages/shared/src/foundation/help-article.ts';

/** sha256 hex of the article body: front matter removed, CRLF normalised, trailing whitespace trimmed. Pinned by tests/unit/capability-help-guard.test.ts. */
export const contentHash = body => createHash('sha256').update(body.replace(/\r\n/g, '\n').trim()).digest('hex');

/** `articles`: [{ lang, path, raw, body }] (path = slug incl. product folder). */
export function buildManifest(articles, generatedAt = new Date().toISOString()) {
  return {
    generatedAt,
    articles: articles.map(a => {
      const h = toHelpArticle(a.path, a.lang, a.raw);
      return {
        slug: a.path,
        lang: a.lang,
        capabilities: h.capabilities.map(c => `${c.id}@${c.version}`),
        appPath: h.appPath ?? null,
        contentHash: contentHash(a.body),
      };
    }),
  };
}
