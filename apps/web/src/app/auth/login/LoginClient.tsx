'use client';

import { useState } from 'react';
import { useAuthFormSubmit } from '../../../hooks/useAuthFormSubmit';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Button, Input } from '@ebda/ui';
import { api } from '@/lib/api';
import { MinimalChrome } from '../../../components';
import { safeInternalPath } from '@ebda/shared';
import { useCart } from '../../../contexts/CartContext';
import { useStoreUrl, useStore } from '../../../contexts/StoreContext';
import { useLanguage } from '../../../contexts/LanguageContext';

export default function LoginClient() {
  const { isLoading, error, submit } = useAuthFormSubmit();
  const router = useRouter();
  const searchParams = useSearchParams();
  const storeUrl = useStoreUrl();
  const { store } = useStore();
  const { syncCartToBackend } = useCart();
  const { t } = useLanguage();
  const [formData, setFormData] = useState({
    email: '',
    password: '',
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await submit(async () => {
      const result = await api.login(formData.email, formData.password, store?.id);

      if (!result.success) {
        throw new Error(result.error?.message || 'Failed to login');
      }

      // Sync local cart to backend after login
      await syncCartToBackend();

      // Redirect to the original page or home. safeInternalPath rejects
      // offsite targets — absolute, protocol-relative (//host), AND backslash
      // tricks (/\host) that the old startsWith('//') check let through.
      const redirectTo = safeInternalPath(searchParams.get('redirect'), '/');
      router.push(storeUrl(redirectTo));
    }, 'Failed to login');
  };

  return (
    <MinimalChrome>
      <div className="flex min-h-[calc(100vh-4rem)] items-center justify-center bg-background px-4 py-12 sm:px-6 lg:px-8">
        <div className="w-full max-w-md space-y-8">
          {/* Header — logo lives in MinimalChrome; keep only the page heading. */}
          <div className="text-center">
            <h2 className="text-3xl font-bold tracking-tight text-foreground">
              {t('Welcome back', 'مرحباً بعودتك')}
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {t("Don't have an account?", 'معندكش حساب؟')}{' '}
              <Link
                href={storeUrl('/auth/register')}
                className="font-medium text-primary hover:underline"
              >
                {t('Sign up', 'إنشاء حساب')}
              </Link>
            </p>
          </div>

          {/* Form */}
          <div className="rounded-xl border bg-card p-8 shadow-sm">
            {error && (
              <div
                role="alert"
                className="mb-4 rounded-lg bg-destructive/10 p-3 text-sm text-destructive-ink"
              >
                {error}
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-6">
              <Input
                label={t('Email address', 'البريد الإلكتروني')}
                type="email"
                autoComplete="email"
                value={formData.email}
                onChange={e => setFormData({ ...formData, email: e.target.value })}
                required
              />

              <div>
                <Input
                  label={t('Password', 'كلمة المرور')}
                  type="password"
                  autoComplete="current-password"
                  value={formData.password}
                  onChange={e => setFormData({ ...formData, password: e.target.value })}
                  required
                />
                <div className="mt-2 text-right">
                  <Link
                    href={storeUrl('/auth/forgot-password')}
                    className="text-sm text-primary hover:underline"
                  >
                    {t('Forgot password?', 'نسيت كلمة المرور؟')}
                  </Link>
                </div>
              </div>

              <Button type="submit" className="w-full" size="lg" isLoading={isLoading}>
                {t('Sign in', 'تسجيل الدخول')}
              </Button>
            </form>
          </div>

          <p className="text-center text-xs text-muted-foreground">
            {t('By signing in, you agree to our', 'لما تسجّل دخول، إنت موافق على')}{' '}
            <Link href={storeUrl('/terms')} className="text-primary hover:underline">
              {t('Terms of Service', 'الشروط والأحكام')}
            </Link>{' '}
            {t('and', 'و')}{' '}
            <Link href={storeUrl('/privacy')} className="text-primary hover:underline">
              {t('Privacy Policy', 'سياسة الخصوصية')}
            </Link>
          </p>
        </div>
      </div>
    </MinimalChrome>
  );
}
