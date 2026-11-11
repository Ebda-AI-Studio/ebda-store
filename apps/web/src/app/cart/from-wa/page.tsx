import { Suspense } from 'react';
import type { Metadata } from 'next';
import WaCheckoutRedeem from './WaCheckoutRedeem';

// Ebda Chat checkout link landing (Ruling WA-RPC-3). Session-bound, never indexed; the token is stripped by the redirect.
export const dynamic = 'force-dynamic';
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default function FromWaPage() {
  return (
    <Suspense fallback={null}>
      <WaCheckoutRedeem />
    </Suspense>
  );
}
