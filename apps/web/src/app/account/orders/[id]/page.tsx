import { Metadata } from 'next';
import OrderDetailClient from './OrderDetailClient';

export const metadata: Metadata = {
  title: 'Order Details',
  robots: { index: false, follow: false },
};

export default function OrderDetailPage() {
  return <OrderDetailClient />;
}
