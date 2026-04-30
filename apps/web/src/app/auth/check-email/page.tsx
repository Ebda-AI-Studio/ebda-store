import { Metadata } from 'next';
import CheckEmailClient from './CheckEmailClient';

export const metadata: Metadata = {
  title: 'Check Your Email',
  description: 'Verification link sent.',
  robots: { index: false, follow: false },
};

export default function CheckEmailPage() {
  return <CheckEmailClient />;
}
