import { inngest } from '../inngest/client';
import { deferAfterTenantCommit } from '../after-tenant-commit';
import { getEmbeddingProvider } from './embedding-provider';
import logger from '../logger';

/** Product columns that feed `ebda_product_embed_doc` (Task 9). A write touching one makes the embedding stale. */
export const EMBED_DOC_FIELDS = [
  'name',
  'nameAr',
  'searchTerms',
  'description',
  'descriptionAr',
] as const;

export function touchesEmbedDoc(fields: Iterable<string>): boolean {
  for (const f of fields) if ((EMBED_DOC_FIELDS as readonly string[]).includes(f)) return true;
  return false;
}

/**
 * Ask the search indexer to look at this store (event `search/store.reindex-requested`, debounced
 * per store by the consumer). Call it after any product-text write that does not go through
 * `ProductService.create/update` (those emit `product.upserted`, which the indexer also consumes).
 *
 * Inside a request it runs after the tenant COMMIT (`deferAfterTenantCommit`); in an Inngest
 * function or script it runs inline. Never throws: a lost event is not a lost write, because
 * `search-index-backstop` finds stale rows by content hash within 6 h. With no embedding provider
 * (no Workers AI binding) it sends nothing: the consumer would only skip.
 */
export async function requestStoreReindex(storeId: string, reason: string): Promise<void> {
  try {
    if (!getEmbeddingProvider()) return;
    await deferAfterTenantCommit('search.reindex-requested', async () => {
      try {
        await inngest.send({ name: 'search/store.reindex-requested', data: { storeId, reason } });
      } catch (err) {
        logger.warn(
          { err, storeId, reason },
          '[search-index] enqueue failed; backstop will catch it'
        );
      }
    });
  } catch (err) {
    logger.warn(
      { err, storeId, reason },
      '[search-index] reindex request failed; backstop will catch it'
    );
  }
}
