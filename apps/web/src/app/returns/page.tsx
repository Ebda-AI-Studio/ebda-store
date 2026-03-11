import type { Metadata } from 'next';
import ReturnsClient from './ReturnsClient';

export const metadata: Metadata = {
  title: 'Returns Policy',
};

export default function ReturnsPage() {
  return <ReturnsClient />;
}
