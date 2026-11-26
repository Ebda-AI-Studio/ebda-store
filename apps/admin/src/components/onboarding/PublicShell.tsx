'use client';

import type { ReactNode } from 'react';
import Image from 'next/image';
import { useLocale } from 'next-intl';
import { BRAND, BRAND_MARKETING_URL } from '@ebda/shared';
import { useT } from '@/i18n/useT';
import AdminLanguageSwitcher from '../AdminLanguageSwitcher';
import { DocumentTitle } from '../DocumentTitle';
import { usePinnedLightTheme } from '@/lib/use-pinned-light-theme';
import { Button } from '@/components/ui/Button';
import { useAuth } from '@/lib/auth';
import { maskEmail } from '@/lib/mask-email';

/**
 * A signed-in person on a setup/gate page (onboarding with no store yet, a refused invite, verify-email) must never be stuck on the wrong
 * account: this shows who is signed in (masked) and a real Sign out button, which ends the session and lands on the sign-in page.
 */
function SignedInStrip() {
  const t = useT('onboarding.shell');
  const { user, isAuthenticated, logout } = useAuth();
  if (!isAuthenticated) return null;
  return (
    <div
      data-testid="signed-in-strip"
      className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1 text-xs text-muted-foreground"
    >
      {user?.email && (
        <span>
          {t('signedInAs')} <bdi dir="ltr">{maskEmail(user.email)}</bdi>
        </span>
      )}
      <Button type="button" variant="outline" size="sm" onClick={() => void logout()}>
        {t('signOut')}
      </Button>
    </div>
  );
}

/** Shared signed-out and setup surface; logical spacing mirrors under RTL. */
export function PublicShell({
  title,
  subtitle,
  children,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  wide?: boolean;
}) {
  const tb = useT('components.brand');
  const t = useT('onboarding.shell');
  const isAr = useLocale() === 'ar';
  usePinnedLightTheme();
  return (
    <main id="admin-main-content" className="min-h-dvh bg-background px-4 py-5 sm:px-6">
      <DocumentTitle title={title} />
      <div className="mx-auto flex min-h-[calc(100dvh-2.5rem)] max-w-6xl flex-col">
        <header className="flex items-center justify-between gap-4 border-b border-border pb-4">
          <a href={BRAND_MARKETING_URL} aria-label={t('back')} className="flex items-center gap-3">
            <Image
              src="/logo-on-light.svg"
              alt={tb('ebdaAlt')}
              width={19}
              height={36}
              className="dark:hidden"
              unoptimized
            />
            <Image
              src="/logo.svg"
              alt={tb('ebdaAlt')}
              width={19}
              height={36}
              className="hidden dark:block"
              unoptimized
            />
            {/* Studio first, then the product: the same lockup order as the sign-in page. */}
            <span className="text-sm font-medium text-primary-ink">
              {isAr ? BRAND.company.shortNameAr : BRAND.company.shortNameEn}
            </span>
            <span aria-hidden="true" className="h-4 w-px bg-border" />
            <span className="text-sm font-semibold">{tb('brandAlt')}</span>
          </a>
          <div className="flex flex-wrap items-center justify-end gap-3">
            <SignedInStrip />
            <AdminLanguageSwitcher />
          </div>
        </header>
        <div className="grid flex-1 items-center gap-8 py-8 lg:grid-cols-[0.85fr_1.15fr] lg:gap-16">
          <aside className="mx-auto w-full max-w-xl lg:mx-0">
            <p className="mb-3 text-xs font-medium text-primary-ink">{t('eyebrow')}</p>
            <h2 className="text-3xl font-semibold leading-tight text-foreground sm:text-4xl">
              {t('title')}
            </h2>
            <p className="mt-4 max-w-sm text-sm leading-relaxed text-muted-foreground">
              {t('body')}
            </p>
            <ol className="mt-8 hidden space-y-6 lg:block">
              {(['store', 'product', 'payment'] as const).map((key, i) => (
                <li key={key} className="flex gap-3">
                  <span
                    aria-hidden="true"
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-primary/30 bg-primary/10 text-xs font-medium text-primary-ink"
                  >
                    {i + 1}
                  </span>
                  <div>
                    <p className="text-sm font-medium text-foreground">{t(key)}</p>
                    <p className="mt-1 max-w-xs text-xs leading-relaxed text-muted-foreground">
                      {t(`${key}Body`)}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          </aside>
          <section
            aria-labelledby="public-page-title"
            className={`mx-auto w-full rounded-lg border border-border bg-card p-5 sm:p-7 ${wide ? 'max-w-xl' : 'max-w-md'}`}
          >
            <h1 id="public-page-title" className="text-xl font-semibold text-foreground">
              {title}
            </h1>
            {subtitle && (
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{subtitle}</p>
            )}
            <div className="mt-6">{children}</div>
          </section>
        </div>
        <footer className="flex flex-wrap items-center justify-between gap-4 border-t border-border py-4 text-xs text-muted-foreground">
          <span>{t('footer')}</span>
          <nav aria-label={t('support')} className="flex flex-wrap gap-5">
            <a className="hover:text-foreground" href={BRAND.legalUrls.terms}>
              {t('terms')}
            </a>
            <a className="hover:text-foreground" href={BRAND.legalUrls.privacy}>
              {t('privacy')}
            </a>
            <a className="hover:text-foreground" href={`mailto:${BRAND.supportEmail}`}>
              {t('support')}
            </a>
          </nav>
        </footer>
      </div>
    </main>
  );
}
