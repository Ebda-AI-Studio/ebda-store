import { Metadata } from 'next';
import SuccessClient from './SuccessClient';

export const metadata: Metadata = {
  title: 'Order Confirmed',
  description: 'Your order has been placed successfully.',
  robots: { index: false, follow: false },
};

export default function CheckoutSuccessPage() {
  return <SuccessClient />;
}
