import type { Metadata } from 'next';
import { localizedMetadata } from '@/lib/seo/localized-metadata';
import ProfileClient from './ProfileClient';

// Track-B — see app/cart/page.tsx sibling comment; same rationale.
export const dynamic = 'force-dynamic';

export function generateMetadata(): Promise<Metadata> {
  return localizedMetadata({
    title: ['My Profile', 'ملفي الشخصي'],
    robots: { index: false, follow: false },
  });
}

export default function ProfilePage() {
  return <ProfileClient />;
}
