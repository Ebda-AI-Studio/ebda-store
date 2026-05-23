'use client';

import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';

/** Thin redirect — all WBS connection config moved to /whatsapp?tab=connection */
export default function WbsIntegrationRedirect() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  useEffect(() => {
    router.replace(`/stores/${id}/whatsapp?tab=connection`);
  }, [id, router]);
  return null;
}
