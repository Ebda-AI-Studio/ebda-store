import type { Metadata } from 'next';
import { localizedMetadata } from '@/lib/seo/localized-metadata';
import RegisterClient from './RegisterClient';

// Track-B — see app/cart/page.tsx sibling comment; same rationale.
export const dynamic = 'force-dynamic';

export function generateMetadata(): Promise<Metadata> {
  return localizedMetadata({
    title: ['Register', 'إنشاء حساب'],
    description: ['Create a new account.', 'أنشئ حسابًا جديدًا.'],
    robots: { index: false, follow: false },
  });
}

export default function RegisterPage() {
  return <RegisterClient />;
}
