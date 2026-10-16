import { sendEventAfterCommit } from '../inngest/send-after-commit';
import { getEmbeddingProvider } from './embedding-provider';

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
 * per store by the consumer). Call it after any product write that changes what is indexed and
 * does not go through `ProductService.create/update` (those emit `product.upserted`).
 *
 * The event is sent only once the caller's writes are COMMITTED (review M7):
 *  - inside a request: after the request transaction commits (`deferAfterTenantCommit`);
 *  - inside a `runInTenantContext` transaction elsewhere (Inngest, MCP, scripts): after THAT
 *    transaction commits (`afterTenantTxCommit`); dropped on rollback;
 *  - inside a caller transaction that cannot be hooked (`scopeTransaction` on a caller's own
 *    `$transaction`): NOT sent, with a warning — the backstop finds the change within 6 h;
 *  - with no transaction at all (`runInStoreScope`, plain code): every statement already
 *    committed, so it is sent at once.
 * Never throws: a lost event is not a lost write (`search-index-backstop` finds stale rows by
 * content hash within 6 h). With no embedding provider it sends nothing (the consumer would skip).
 */
export async function requestStoreReindex(storeId: string, reason: string): Promise<void> {
  if (!getEmbeddingProvider()) return;
  // 'drop' when it cannot know the commit: the 6-hourly backstop finds the change by hash.
  await sendEventAfterCommit(
    'search.reindex-requested',
    { name: 'search/store.reindex-requested', data: { storeId, reason } },
    { ifUnhookable: 'drop' }
  );
}
