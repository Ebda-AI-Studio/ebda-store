'use client';

import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';

/** Thin redirect — all template management moved to /whatsapp?tab=templates */
export default function WaTemplatesRedirect() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  useEffect(() => {
    router.replace(`/stores/${id}/whatsapp?tab=templates`);
  }, [id, router]);
  return null;
}
