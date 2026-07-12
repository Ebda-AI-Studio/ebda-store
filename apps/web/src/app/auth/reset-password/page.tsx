import { Metadata } from 'next';
import ResetPasswordClient from './ResetPasswordClient';

// Track-B — see app/cart/page.tsx sibling comment; same rationale.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Reset Password',
  description: 'Set a new password for your account.',
  robots: { index: false, follow: false },
};

export default function ResetPasswordPage() {
  return <ResetPasswordClient />;
}
