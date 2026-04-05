import { Metadata } from 'next';
import LoyaltyClient from './LoyaltyClient';

export const metadata: Metadata = {
  title: 'Loyalty Program',
  robots: { index: false, follow: false },
};

export default function LoyaltyPage() {
  return <LoyaltyClient />;
}
