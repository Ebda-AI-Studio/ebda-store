import type { Metadata } from 'next';
import { localizedMetadata } from '@/lib/seo/localized-metadata';
import AccountDashboardClient from './AccountDashboardClient';

// Track-B — see app/cart/page.tsx sibling comment; same rationale.
export const dynamic = 'force-dynamic';

export function generateMetadata(): Promise<Metadata> {
  return localizedMetadata({
    title: ['My Account', 'حسابي'],
    description: ['Manage your account, orders, and settings.', 'أدِر حسابك وطلباتك وإعداداتك.'],
    robots: { index: false, follow: false },
  });
}

export default function AccountPage() {
  return <AccountDashboardClient />;
}
