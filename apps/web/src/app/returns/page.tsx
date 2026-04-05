import type { Metadata } from 'next';
import ReturnsClient from './ReturnsClient';

export const metadata: Metadata = {
  title: 'Returns Policy',
  description: 'Our return and exchange policy. Learn how to return or exchange products.',
};

export default function ReturnsPage() {
  return <ReturnsClient />;
}
