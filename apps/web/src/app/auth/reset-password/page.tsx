'use client';

import { useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Image from 'next/image';
import Link from 'next/link';
import { Button, Input } from '@force/ui';
import { api } from '@/lib/api';
import { useStore, useStoreUrl } from '../../../contexts/StoreContext';

function ResetPasswordForm() {
  const searchParams = useSearchParams();
  const token = searchParams?.get('token') || '';
  const { store } = useStore();
  const storeUrl = useStoreUrl();

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [formData, setFormData] = useState({
    newPassword: '',
    confirmPassword: '',
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!token) {
      setError('Invalid or missing reset token. Please request a new password reset link.');
      return;
    }

    if (formData.newPassword !== formData.confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    if (formData.newPassword.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }

    setIsLoading(true);

    try {
      // The API's reset-password endpoint accepts { token, password }
      const result = await api.resetPassword(token, formData.newPassword);

      if (!result.success) {
        throw new Error(result.error?.message || 'Failed to reset password');
      }

      setSuccess(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reset password. Please try again.');
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
            Reset your password
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">Enter your new password below.</p>
        </div>

        {/* Form */}
        <div className="rounded-xl border bg-white p-8 shadow-sm">
          {success ? (
            <div className="space-y-4 text-center">
              <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-green-100">
                <svg
                  className="h-8 w-8 text-green-600"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M5 13l4 4L19 7"
                  />
                </svg>
              </div>
              <h3 className="text-lg font-semibold text-foreground">Password reset successfully</h3>
              <p className="text-sm text-muted-foreground">
                Your password has been updated. You can now sign in with your new password.
              </p>
              <Link
                href={storeUrl('/auth/login')}
                className="mt-4 inline-block font-medium text-primary hover:underline"
              >
                Back to sign in
              </Link>
            </div>
          ) : (
            <>
              {error && (
                <div className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-600">{error}</div>
              )}

              {!token && (
                <div className="mb-4 rounded-lg bg-yellow-50 p-3 text-sm text-yellow-700">
                  No reset token found. Please use the link from your password reset email.
                </div>
              )}

              <form onSubmit={handleSubmit} className="space-y-6">
                <Input
                  label="New Password"
                  type="password"
                  autoComplete="new-password"
                  value={formData.newPassword}
                  onChange={e => setFormData({ ...formData, newPassword: e.target.value })}
                  required
                  disabled={!token}
                />

                <Input
                  label="Confirm New Password"
                  type="password"
                  autoComplete="new-password"
                  value={formData.confirmPassword}
                  onChange={e => setFormData({ ...formData, confirmPassword: e.target.value })}
                  required
                  disabled={!token}
                />

                <Button
                  type="submit"
                  className="w-full"
                  size="lg"
                  isLoading={isLoading}
                  disabled={!token}
                >
                  Reset Password
                </Button>
              </form>

              <div className="mt-4 text-center">
                <Link
                  href={storeUrl('/auth/login')}
                  className="text-sm text-primary hover:underline"
                >
                  Back to sign in
                </Link>
              </div>
            </>
          )}
        </div>

        <p className="text-center text-xs text-muted-foreground">
          Need a new reset link?{' '}
          <Link href={storeUrl('/auth/forgot-password')} className="text-primary hover:underline">
            Request password reset
          </Link>
        </p>
      </div>
    </main>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense
      fallback={
        <main className="flex min-h-screen items-center justify-center bg-background">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        </main>
      }
    >
      <ResetPasswordForm />
    </Suspense>
  );
}
