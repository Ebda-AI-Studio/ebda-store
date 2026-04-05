import { Metadata } from 'next';
import AccountDashboardClient from './AccountDashboardClient';

export const metadata: Metadata = {
  title: 'My Account',
  description: 'Manage your account, orders, and settings.',
  robots: { index: false, follow: false },
};

export default function AccountPage() {
  return <AccountDashboardClient />;
}
