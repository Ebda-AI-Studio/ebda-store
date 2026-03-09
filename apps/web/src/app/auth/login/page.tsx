'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Image from 'next/image';
import Link from 'next/link';
import { Button, Input } from '@force/ui';
import { api } from '@/lib/api';
import { useCart } from '../../../contexts/CartContext';
import { useStore, useStoreUrl } from '../../../contexts/StoreContext';
import { useLanguage } from '../../../contexts/LanguageContext';

export default function LoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { store } = useStore();
  const storeUrl = useStoreUrl();
  const { syncCartToBackend } = useCart();
  const { t } = useLanguage();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [formData, setFormData] = useState({
    email: '',
    password: '',
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError('');

    try {
      const result = await api.login(formData.email, formData.password);

      if (!result.success) {
        throw new Error(result.error?.message || 'Failed to login');
      }

      // Sync local cart to backend after login
      await syncCartToBackend();

      // Redirect to the original page or home
      const redirectTo = searchParams.get('redirect') || '/';
      router.push(storeUrl(redirectTo));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to login');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-12 sm:px-6 lg:px-8">
      <div className="w-full max-w-md space-y-8">
        {/* Header */}
        <div className="text-center">
          <Link href={storeUrl('/')} className="inline-flex items-center gap-2">
            {store.logo ? (
              <Image src={store.logo} alt={store.name} width={48} height={36} />
            ) : (
              <Image src="/logo.svg" alt={store.name} width={48} height={36} />
            )}
            <span className="text-2xl font-bold text-foreground">{store.name}</span>
          </Link>
          <h2 className="mt-6 text-3xl font-bold tracking-tight text-foreground">
            {t('Welcome back', 'مرحباً بعودتك')}
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {t("Don't have an account?", 'ليس لديك حساب؟')}{' '}
            <Link
              href={storeUrl('/auth/register')}
              className="font-medium text-primary hover:underline"
            >
              {t('Sign up', 'إنشاء حساب')}
            </Link>
          </p>
        </div>

        {/* Form */}
        <div className="rounded-xl border bg-white p-8 shadow-sm">
          {error && (
            <div className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-600">{error}</div>
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
          {t('By signing in, you agree to our', 'بتسجيل الدخول، أنت توافق على')}{' '}
          <Link href={storeUrl('/terms')} className="text-primary hover:underline">
            {t('Terms of Service', 'الشروط والأحكام')}
          </Link>{' '}
          {t('and', 'و')}{' '}
          <Link href={storeUrl('/privacy')} className="text-primary hover:underline">
            {t('Privacy Policy', 'سياسة الخصوصية')}
          </Link>
        </p>
      </div>
    </main>
  );
}
