'use client';

import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';

/** Thin redirect — all order-update config moved to /whatsapp?tab=order-updates */
export default function WaOrderUpdatesRedirect() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  useEffect(() => {
    router.replace(`/stores/${id}/whatsapp?tab=order-updates`);
  }, [id, router]);
  return null;
}
