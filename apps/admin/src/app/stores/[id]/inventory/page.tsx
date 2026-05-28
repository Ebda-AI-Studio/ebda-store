'use client';

/**
 * /stores/[id]/inventory — GHOST ROUTE redirect.
 *
 * This page was orphaned from sidebar navigation after the stock hub
 * was introduced with `/stock/inventory` as the canonical path. Any
 * existing bookmarks or deep-links pointing here are permanently
 * redirected to the live page. The original page content is preserved
 * at `/stores/[id]/stock/inventory`.
 *
 * Audit ref: 2026-05-28-admin-error-handling-and-naming.md §Class B /inventory
 */

import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';

export default function InventoryRedirect() {
  const params = useParams<{ id: string }>();
  const router = useRouter();

  useEffect(() => {
    router.replace(`/stores/${params.id}/stock/inventory`);
  }, [params.id, router]);

  return (
    <div className="flex items-center justify-center py-24">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
    </div>
  );
}
