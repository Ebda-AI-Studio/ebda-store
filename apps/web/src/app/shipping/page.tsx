import type { Metadata } from 'next';
import ShippingClient from './ShippingClient';

export const metadata: Metadata = {
  title: 'Shipping Policy',
  description: 'Learn about our shipping options, delivery times, and costs.',
};

export default function ShippingPage() {
  return <ShippingClient />;
}
