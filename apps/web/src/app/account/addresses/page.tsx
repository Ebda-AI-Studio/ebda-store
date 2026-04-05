import { Metadata } from 'next';
import AddressesClient from './AddressesClient';

export const metadata: Metadata = {
  title: 'My Addresses',
  robots: { index: false, follow: false },
};

export default function AddressesPage() {
  return <AddressesClient />;
}
