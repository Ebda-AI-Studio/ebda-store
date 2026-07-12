import { Metadata } from 'next';
import CheckEmailClient from './CheckEmailClient';

// Track-B — see app/cart/page.tsx sibling comment; same rationale.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Check Your Email',
  description: 'Verification link sent.',
  robots: { index: false, follow: false },
};

export default function CheckEmailPage() {
  return <CheckEmailClient />;
}
