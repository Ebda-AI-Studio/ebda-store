'use client';

import { useState } from 'react';
import { useAuthFormSubmit } from '../../../hooks/useAuthFormSubmit';
import { validateRegistration } from './validate-registration';
import { useRouter } from 'next/navigation';
import Link from '../../../components/StoreLink';
import { Button, Input } from '@ebda/ui';
import { api } from '@/lib/api';
import { MinimalChrome } from '../../../components';
import { useStoreUrl, useStore } from '../../../contexts/StoreContext';
import { useLanguage } from '../../../contexts/LanguageContext';
import { demoRefusalText } from '../../../lib/demo-refusal';

export default function RegisterClient() {
  const { isLoading, error, setError, submit } = useAuthFormSubmit();
  const router = useRouter();
  const storeUrl = useStoreUrl();
  const { store } = useStore();
  const { t } = useLanguage();
  const [formData, setFormData] = useState({
    firstName: '',
    lastName: '',
    email: '',
    password: '',
    confirmPassword: '',
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // Validate before touching the network. Returning a message rather than
    // setting state keeps the rule testable — see validateRegistration.
    const validationError = validateRegistration(formData, t);
    if (validationError) {
      setError(validationError);
      return;
    }

    await submit(
      async () => {
        const result = await api.register({
          email: formData.email,
          password: formData.password,
          firstName: formData.firstName,
          lastName: formData.lastName,
          storeId: store?.id,
        });

        if (!result.success) {
          throw new Error(
            demoRefusalText(result.error, t) ||
              result.error?.message ||
              t('Failed to register', 'فشل إنشاء الحساب')
          );
        }

        // T1-4: register no longer returns tokens. The API responds the same way
        // for new and existing emails (enumeration close), so we always send the
        // user to the "verify your email" page — they get a link in their inbox
        // (real registration) or a "someone tried to register with this email"
        // notice (existing account). Either way the next action is in their
        // inbox, not here.
        router.push(storeUrl('/auth/check-email'));
      },
      t('Failed to register', 'فشل إنشاء الحساب')
    );
  };

  return (
    <MinimalChrome>
      <div className="flex min-h-[calc(100vh-4rem)] items-center justify-center bg-background px-4 py-12 sm:px-6 lg:px-8">
        <div className="w-full max-w-md space-y-8">
          {/* Header — logo lives in MinimalChrome; keep only the page heading. */}
          <div className="text-center">
            <h2 className="text-3xl font-bold tracking-tight text-foreground">
              {t('Create your account', 'إنشاء حسابك')}
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {t('Already have an account?', 'عندك حساب؟')}{' '}
              <Link
                href={storeUrl('/auth/login')}
                className="font-medium text-primary underline underline-offset-2"
              >
                {t('Sign in', 'تسجيل الدخول')}
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

              <div className="flex items-start gap-3">
                <input
                  id="terms"
                  type="checkbox"
                  className="mt-0.5 h-5 w-5 shrink-0 rounded border-input text-primary focus:ring-primary"
                  required
                />
                <label htmlFor="terms" className="text-sm text-muted-foreground">
                  {t('I agree to the', 'أوافق على')}{' '}
                  <Link
                    href={storeUrl('/terms')}
                    className="text-primary underline underline-offset-2"
                  >
                    {t('Terms of Service', 'الشروط والأحكام')}
                  </Link>{' '}
                  {t('and', 'و')}{' '}
                  <Link
                    href={storeUrl('/privacy')}
                    className="text-primary underline underline-offset-2"
                  >
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
      </div>
    </MinimalChrome>
  );
}
