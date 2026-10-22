import type { Metadata } from 'next';
import { localizedMetadata } from '@/lib/seo/localized-metadata';
import { Suspense } from 'react';
import LoginClient from './LoginClient';

// Track-B — see app/cart/page.tsx sibling comment; same rationale.
export const dynamic = 'force-dynamic';

export function generateMetadata(): Promise<Metadata> {
  return localizedMetadata({
    title: ['Login', 'تسجيل الدخول'],
    description: ['Sign in to your account.', 'سجّل الدخول إلى حسابك.'],
    robots: { index: false, follow: false },
  });
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <main className="flex min-h-screen items-center justify-center bg-background">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        </main>
      }
    >
      <LoginClient />
    </Suspense>
  );
}
