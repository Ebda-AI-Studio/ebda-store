import type { Metadata } from 'next';
import { localizedMetadata } from '@/lib/seo/localized-metadata';
import ForgotPasswordClient from './ForgotPasswordClient';

// Track-B — see app/cart/page.tsx sibling comment; same rationale.
export const dynamic = 'force-dynamic';

export function generateMetadata(): Promise<Metadata> {
  return localizedMetadata({
    title: ['Forgot Password', 'نسيت كلمة المرور'],
    description: ['Reset your account password.', 'أعد تعيين كلمة مرور حسابك.'],
    robots: { index: false, follow: false },
  });
}

export default function ForgotPasswordPage() {
  return <ForgotPasswordClient />;
}
