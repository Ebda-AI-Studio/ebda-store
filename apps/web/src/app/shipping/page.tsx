import type { Metadata } from 'next';
import ShippingClient from './ShippingClient';

export const metadata: Metadata = {
  title: 'Shipping Policy',
};

export default function ShippingPage() {
  return <ShippingClient />;
}
