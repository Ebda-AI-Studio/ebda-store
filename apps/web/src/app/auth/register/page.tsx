'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import Link from 'next/link';
import { Button, Input } from '@force/ui';
import { api } from '@/lib/api';
import { useStore, useStoreUrl } from '../../../contexts/StoreContext';
import { useLanguage } from '../../../contexts/LanguageContext';

export default function RegisterPage() {
  const router = useRouter();
  const { store } = useStore();
  const storeUrl = useStoreUrl();
  const { t } = useLanguage();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [formData, setFormData] = useState({
    firstName: '',
    lastName: '',
    email: '',
    password: '',
    confirmPassword: '',
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError('');

    // Validate passwords match
    if (formData.password !== formData.confirmPassword) {
      setError('Passwords do not match');
      setIsLoading(false);
      return;
    }

    // Validate password strength
    if (formData.password.length < 8) {
      setError('Password must be at least 8 characters');
      setIsLoading(false);
      return;
    }

    try {
      const result = await api.register({
        email: formData.email,
        password: formData.password,
        firstName: formData.firstName,
        lastName: formData.lastName,
      });

      if (!result.success) {
        throw new Error(result.error?.message || 'Failed to register');
      }

      // Store tokens (api.register already stores them, but be explicit)
      if (result.data) {
        localStorage.setItem('accessToken', result.data.accessToken);
        localStorage.setItem('refreshToken', result.data.refreshToken);
      }

      // Redirect to home
      router.push(storeUrl('/'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to register');
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
            {t('Create your account', 'إنشاء حسابك')}
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {t('Already have an account?', 'لديك حساب بالفعل؟')}{' '}
            <Link
              href={storeUrl('/auth/login')}
              className="font-medium text-primary hover:underline"
            >
              {t('Sign in', 'تسجيل الدخول')}
            </Link>
          </p>
        </div>

        {/* Form */}
        <div className="rounded-xl border bg-white p-8 shadow-sm">
          {error && (
            <div className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-600">{error}</div>
          )}

          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="grid grid-cols-2 gap-4">
              <Input
                label={t('First name', 'الاسم الأول')}
                autoComplete="given-name"
                value={formData.firstName}
                onChange={e => setFormData({ ...formData, firstName: e.target.value })}
                required
              />
              <Input
                label={t('Last name', 'اسم العائلة')}
                autoComplete="family-name"
                value={formData.lastName}
                onChange={e => setFormData({ ...formData, lastName: e.target.value })}
                required
              />
            </div>

            <Input
              label={t('Email address', 'البريد الإلكتروني')}
              type="email"
              autoComplete="email"
              value={formData.email}
              onChange={e => setFormData({ ...formData, email: e.target.value })}
              required
            />

            <Input
              label={t('Password', 'كلمة المرور')}
              type="password"
              autoComplete="new-password"
              value={formData.password}
              onChange={e => setFormData({ ...formData, password: e.target.value })}
              required
            />

            <Input
              label={t('Confirm password', 'تأكيد كلمة المرور')}
              type="password"
              autoComplete="new-password"
              value={formData.confirmPassword}
              onChange={e => setFormData({ ...formData, confirmPassword: e.target.value })}
              required
            />

            <div className="flex items-start gap-2">
              <input
                id="terms"
                type="checkbox"
                className="mt-1 h-4 w-4 rounded border-border text-primary focus:ring-primary"
                required
              />
              <label htmlFor="terms" className="text-sm text-muted-foreground">
                {t('I agree to the', 'أوافق على')}{' '}
                <Link href={storeUrl('/terms')} className="text-primary hover:underline">
                  {t('Terms of Service', 'الشروط والأحكام')}
                </Link>{' '}
                {t('and', 'و')}{' '}
                <Link href={storeUrl('/privacy')} className="text-primary hover:underline">
                  {t('Privacy Policy', 'سياسة الخصوصية')}
                </Link>
              </label>
            </div>

            <Button type="submit" className="w-full" size="lg" isLoading={isLoading}>
              {t('Create account', 'إنشاء حساب')}
            </Button>
          </form>
        </div>
      </div>
    </main>
  );
}
