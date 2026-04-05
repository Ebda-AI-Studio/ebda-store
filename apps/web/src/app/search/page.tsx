import type { Metadata } from 'next';
import SearchClient from './SearchClient';

export const metadata: Metadata = {
  title: 'Search',
  description: 'Search for products in our store.',
};

export default function SearchPage() {
  return <SearchClient />;
}
