import type { Metadata } from 'next';
import { localizedMetadata } from '@/lib/seo/localized-metadata';
import ResetPasswordClient from './ResetPasswordClient';

// Track-B — see app/cart/page.tsx sibling comment; same rationale.
export const dynamic = 'force-dynamic';

export function generateMetadata(): Promise<Metadata> {
  return localizedMetadata({
    title: ['Reset Password', 'إعادة تعيين كلمة المرور'],
    description: ['Set a new password for your account.', 'اختر كلمة مرور جديدة لحسابك.'],
    robots: { index: false, follow: false },
  });
}

export default function ResetPasswordPage() {
  return <ResetPasswordClient />;
}
