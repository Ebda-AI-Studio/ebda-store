import { Metadata } from 'next';
import LoyaltyClient from './LoyaltyClient';

export const metadata: Metadata = {
  title: 'Loyalty Program',
};

export default function LoyaltyPage() {
  return <LoyaltyClient />;
}
