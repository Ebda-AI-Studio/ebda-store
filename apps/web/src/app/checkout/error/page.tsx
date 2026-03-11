import { Metadata } from 'next';
import ErrorClient from './ErrorClient';

export const metadata: Metadata = {
  title: 'Payment Error',
};

export default function CheckoutErrorPage() {
  return <ErrorClient />;
}
