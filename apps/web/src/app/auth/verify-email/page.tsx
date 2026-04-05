import { Metadata } from 'next';
import VerifyEmailClient from './VerifyEmailClient';

export const metadata: Metadata = {
  title: 'Verify Email',
  description: 'Verify your email address.',
  robots: { index: false, follow: false },
};

export default function VerifyEmailPage() {
  return <VerifyEmailClient />;
}
