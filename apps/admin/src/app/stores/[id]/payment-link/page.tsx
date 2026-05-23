'use client';

import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';

/** Thin redirect — payment link feature moved to /whatsapp?tab=payment-link */
export default function PaymentLinkRedirect() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  useEffect(() => {
    router.replace(`/stores/${id}/whatsapp?tab=payment-link`);
  }, [id, router]);
  return null;
}
