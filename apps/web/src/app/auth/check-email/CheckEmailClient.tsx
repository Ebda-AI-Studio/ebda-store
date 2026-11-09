'use client';

import { useEffect, useState } from 'react';
import Link from '../../../components/StoreLink';
import { Button } from '@ebda/ui';
import { MinimalChrome } from '../../../components';
import { useStoreUrl } from '../../../contexts/StoreContext';
import { useLanguage } from '../../../contexts/LanguageContext';
import ResendVerification, {
  PENDING_VERIFICATION_EMAIL_KEY,
} from '../../../components/ResendVerification';

export default function CheckEmailClient() {
  const storeUrl = useStoreUrl();
  const { t } = useLanguage();
  const [email, setEmail] = useState('');
  useEffect(() => {
    try {
      setEmail(sessionStorage.getItem(PENDING_VERIFICATION_EMAIL_KEY) ?? '');
    } catch {
      /* storage blocked: ResendVerification asks for the address */
    }
  }, []);

  return (
    <MinimalChrome>
      <div className="flex min-h-[calc(100vh-4rem)] items-center justify-center bg-background px-4 py-12 sm:px-6 lg:px-8">
        <div className="w-full max-w-md space-y-6 text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-8 w-8 text-primary"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8m-2 13H5a2 2 0 01-2-2V5a2 2 0 012-2h14a2 2 0 012 2v14a2 2 0 01-2 2z"
              />
            </svg>
          </div>

          <h1 className="text-3xl font-bold tracking-tight text-foreground">
            {t('Check your email', 'تحقق من بريدك')}
          </h1>

          <p className="text-muted-foreground">
            {t(
              "We've sent a verification link to your inbox. Open the email and click the link to finish setting up your account.",
              'بعتنا رابط التأكيد على بريدك. افتح البريد ودوس على الرابط عشان تكمّل إعداد حسابك.'
            )}
          </p>

          <p className="text-sm text-muted-foreground">
            {t(
              "If your email is already registered, we'll let you know in your inbox so you can sign in or reset your password.",
              'لو بريدك متسجل قبل كده، هنبعتلك على بريدك عشان تسجّل دخول أو تغيّر كلمة المرور.'
            )}
          </p>

          <ResendVerification email={email} />

          <div className="flex flex-col gap-3">
            <Link href={storeUrl('/auth/login')}>
              <Button className="w-full">{t('Go to sign in', 'انتقل إلى تسجيل الدخول')}</Button>
            </Link>
            <Link
              href={storeUrl('/auth/register')}
              className="text-sm text-primary hover:underline"
            >
              {t('Use a different email', 'استخدم بريداً آخر')}
            </Link>
          </div>
        </div>
      </div>
    </MinimalChrome>
  );
}
