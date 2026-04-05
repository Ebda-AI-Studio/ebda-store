import type { Metadata } from 'next';
import RegisterClient from './RegisterClient';

export const metadata: Metadata = {
  title: 'Register',
  description: 'Create a new account.',
  robots: { index: false, follow: false },
};

export default function RegisterPage() {
  return <RegisterClient />;
}
