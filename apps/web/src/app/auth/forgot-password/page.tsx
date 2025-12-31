'use client';

import { useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { Button, Input } from '@force/ui';
import { api } from '@/lib/api';

export default function ForgotPasswordPage() {
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError('');

    try {
      const result = await api.forgotPassword(email);

      if (!result.success) {
        throw new Error(result.error?.message || 'Failed to send reset email');
      }

      setIsSubmitted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send reset email');
    } finally {
      setIsLoading(false);
    }
  };

  if (isSubmitted) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-gray-50 px-4 py-12 sm:px-6 lg:px-8">
        <div className="w-full max-w-md space-y-8 text-center">
          <Link href="/" className="inline-flex items-center gap-2">
            <Image src="/logo.svg" alt="Force Media" width={48} height={36} />
            <span className="text-2xl font-bold">
              <span className="text-primary">Force</span>
              <span className="text-gray-700"> Store</span>
            </span>
          </Link>

          <div className="rounded-xl border bg-white p-8 shadow-sm">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-green-100">
              <svg
                className="h-6 w-6 text-green-600"
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
            <h2 className="mt-4 text-xl font-semibold text-gray-900">Check your email</h2>
            <p className="mt-2 text-sm text-gray-600">
              We&apos;ve sent a password reset link to <strong>{email}</strong>
            </p>
            <p className="mt-4 text-xs text-gray-500">
              Didn&apos;t receive the email? Check your spam folder or{' '}
              <button
                onClick={() => setIsSubmitted(false)}
                className="text-primary hover:underline"
              >
                try again
              </button>
            </p>
          </div>

          <Link href="/auth/login" className="inline-block text-sm text-primary hover:underline">
            &larr; Back to sign in
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-50 px-4 py-12 sm:px-6 lg:px-8">
      <div className="w-full max-w-md space-y-8">
        {/* Header */}
        <div className="text-center">
          <Link href="/" className="inline-flex items-center gap-2">
            <Image src="/logo.svg" alt="Force Media" width={48} height={36} />
            <span className="text-2xl font-bold">
              <span className="text-primary">Force</span>
              <span className="text-gray-700"> Store</span>
            </span>
          </Link>
          <h2 className="mt-6 text-3xl font-bold tracking-tight text-gray-900">Forgot password?</h2>
          <p className="mt-2 text-sm text-gray-600">
            No worries, we&apos;ll send you reset instructions.
          </p>
        </div>

        {/* Form */}
        <div className="rounded-xl border bg-white p-8 shadow-sm">
          {error && (
            <div className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-600">{error}</div>
          )}

          <form onSubmit={handleSubmit} className="space-y-6">
            <Input
              label="Email address"
              type="email"
              autoComplete="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
            />

            <Button type="submit" className="w-full" size="lg" isLoading={isLoading}>
              Send reset link
            </Button>
          </form>
        </div>

        <p className="text-center text-sm">
          <Link href="/auth/login" className="text-primary hover:underline">
            &larr; Back to sign in
          </Link>
        </p>
      </div>
    </main>
  );
}
