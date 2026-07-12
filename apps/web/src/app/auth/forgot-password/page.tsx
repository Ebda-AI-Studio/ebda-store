import { Metadata } from 'next';
import ForgotPasswordClient from './ForgotPasswordClient';

// Track-B — see app/cart/page.tsx sibling comment; same rationale.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Forgot Password',
  description: 'Reset your account password.',
  robots: { index: false, follow: false },
};

export default function ForgotPasswordPage() {
  return <ForgotPasswordClient />;
}
