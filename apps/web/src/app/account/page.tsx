import { Metadata } from 'next';
import AccountDashboardClient from './AccountDashboardClient';

export const metadata: Metadata = {
  title: 'My Account',
};

export default function AccountPage() {
  return <AccountDashboardClient />;
}
