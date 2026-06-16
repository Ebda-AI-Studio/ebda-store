'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { z } from 'zod';
import { useAuth } from '@/lib/auth';
import { useLanguage } from '@/contexts/LanguageContext';
import { LangToggle } from '@/components/LangToggle';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export default function LoginPage() {
  const router = useRouter();
  const { login, isAuthenticated, isLoading } = useAuth();
  const { t } = useLanguage();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Already signed in → go straight to orders.
  useEffect(() => {
    if (!isLoading && isAuthenticated) router.replace('/orders');
  }, [isLoading, isAuthenticated, router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const parsed = loginSchema.safeParse({ email: email.trim(), password });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      setError(issue?.path[0] === 'email' ? t.login.invalidEmail : t.login.passwordRequired);
      return;
    }

    setSubmitting(true);
    try {
      await login(parsed.data.email, parsed.data.password);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      setError(msg === 'ADMIN_ONLY' ? t.login.adminOnly : msg || t.login.failed);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <div className="flex justify-end p-4">
        <LangToggle />
      </div>
      <div className="flex flex-1 items-center justify-center px-4 pb-16">
        <div className="w-full max-w-sm">
          <div className="mb-8 text-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/logo.svg"
              alt="Force AI Store"
              className="mx-auto mb-4 h-14 w-auto"
              width={64}
              height={54}
            />
            <h1 className="text-xl font-bold text-foreground">{t.login.title}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{t.login.subtitle}</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="email" className="mb-1 block text-sm font-medium text-foreground">
                {t.login.email}
              </label>
              <input
                id="email"
                type="email"
                autoComplete="username"
                inputMode="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                className="h-12 w-full rounded-xl border border-input bg-card px-4 text-base text-foreground outline-none focus:border-primary"
                required
              />
            </div>
            <div>
              <label htmlFor="password" className="mb-1 block text-sm font-medium text-foreground">
                {t.login.password}
              </label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                className="h-12 w-full rounded-xl border border-input bg-card px-4 text-base text-foreground outline-none focus:border-primary"
                required
              />
            </div>

            {error && (
              <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="h-12 w-full rounded-xl bg-primary text-base font-semibold text-primary-foreground active:opacity-90 disabled:opacity-60"
            >
              {submitting ? t.login.submitting : t.login.submit}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
