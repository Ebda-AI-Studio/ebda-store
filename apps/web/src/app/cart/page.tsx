import type { Metadata } from 'next';
import { localizedMetadata } from '@/lib/seo/localized-metadata';
import { Suspense } from 'react';
import CartClient from './CartClient';
import CartRestoreHydrator from './CartRestoreHydrator';
import { defaultPageDocument } from '@ebda/shared';
import { getStore } from '../../lib/store-resolver';
import { fetchPageDocument, builderTokenFrom } from '../../lib/page-document';
import { PageDocumentProvider } from '../../builder/render/PageDocument';
import { allowedParentOrigins } from '../../builder/preview/allowed-parent-origins';

// Track-B (personalized, session-bound) — stays outside the new `tenant-store`
// tree by design. Already dynamic today via the root layout's headers()/
// cookies() calls; this makes it explicit and immune to accidentally
// becoming static later. Verified no-op — see
// docs/plans/done/2026-07-12-tenant-cacheable-routing.md §3.3/§4/§9.
export const dynamic = 'force-dynamic';

export function generateMetadata(): Promise<Metadata> {
  return localizedMetadata({
    title: ['Cart', 'سلة التسوق'],
    description: ['Review items in your shopping cart.', 'راجع القطع في سلة التسوق.'],
    robots: { index: false, follow: false },
  });
}

export default async function CartPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [store, query] = await Promise.all([getStore(), searchParams ?? {}]);
  // The cart page's section document (published, or the draft for the editor canvas); a failure
  // renders today's order.
  const pageDocument = await fetchPageDocument(store.id, 'cart', builderTokenFrom(query));
  return (
    <>
      {/* The cart-recovery email lands on /cart?restore=<token>; the hydrator re-attaches that
          cart to this browser, then renders null. Suspense because useSearchParams suspends. */}
      <Suspense fallback={null}>
        <CartRestoreHydrator />
      </Suspense>
      <PageDocumentProvider
        kind="cart"
        initialDefinition={pageDocument?.definition ?? defaultPageDocument('cart')}
        editorMode={pageDocument?.editorMode === true}
        allowedOrigins={allowedParentOrigins()}
      >
        <CartClient />
      </PageDocumentProvider>
    </>
  );
}
