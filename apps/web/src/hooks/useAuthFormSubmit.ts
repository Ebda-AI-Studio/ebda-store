'use client';

import { useState, useCallback } from 'react';

/**
 * The submit lifecycle every auth form in this app repeats verbatim:
 * set loading, clear the previous error, run the call, surface a message on
 * failure, always clear loading.
 *
 * Five clients (login, register, forgot-password, reset-password, verify-email)
 * each carried their own copy. Five copies of an error path is five places for
 * a form to silently stay stuck in `isLoading` after a throw — which is the bug
 * this shape exists to prevent, and the reason `finally` is not optional.
 *
 * The hook owns ONLY loading + error. Flow-specific state (isSubmitted, success,
 * resend counters) stays in the component, because those differ per form and
 * flattening them into one hook would be a worse abstraction than the copies.
 */
export function useAuthFormSubmit() {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  /**
   * Run an auth action with the standard lifecycle.
   *
   * `fallbackMessage` is used when the thrown value carries no usable message —
   * never show the raw object to a shopper.
   * Returns true on success so callers can gate their own follow-up state.
   */
  const submit = useCallback(
    async (action: () => Promise<void>, fallbackMessage: string): Promise<boolean> => {
      setIsLoading(true);
      setError('');
      try {
        await action();
        return true;
      } catch (err) {
        setError(err instanceof Error && err.message ? err.message : fallbackMessage);
        return false;
      } finally {
        setIsLoading(false);
      }
    },
    []
  );

  return { isLoading, error, setError, setIsLoading, submit };
}
