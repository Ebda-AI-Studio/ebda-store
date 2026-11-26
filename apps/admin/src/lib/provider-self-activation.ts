'use client';

import { apiPost, apiRequest } from './api';

interface ActivationTriage {
  en: string;
  ar: string;
  source: 'ai' | 'fixed';
}

type Preview =
  | {
      outcome: 'ready';
      mode: string;
      unverifiedConnection: boolean;
      confirmToken: string;
    }
  | { outcome: 'failed'; triage: ActivationTriage };

type SelfActivationResult =
  | { status: 'activated'; mode: string; unverifiedConnection: boolean }
  /** The merchant closed the confirm dialog: nothing changed. */
  | { status: 'cancelled' }
  /** The server-run check failed: show the plain sentence, nothing was turned on. */
  | { status: 'failed'; triage: ActivationTriage }
  | { status: 'error'; code: string; message: string };

/**
 * "Test and turn on" (gap A7). Step 1 asks the SERVER to run Test connection; only a pass returns a confirm token.
 * `askConfirm` shows the checkout-visible confirmation (the caller owns the wording); step 2 sends the token with
 * ONE Idempotency-Key for this attempt, so a double click or a retry cannot activate twice.
 */
export async function selfActivateProvider(
  storeId: string,
  provider: string,
  askConfirm: (info: { mode: string; unverifiedConnection: boolean }) => Promise<boolean>
): Promise<SelfActivationResult> {
  const root = `/api/v1/provider-activation/store/${storeId}/${provider}/activate`;
  const { data, error } = await apiPost<Preview>(`${root}/preview`);
  if (error || !data) {
    return { status: 'error', code: error?.code ?? 'UNKNOWN', message: error?.message ?? '' };
  }
  if (data.outcome === 'failed') return { status: 'failed', triage: data.triage };
  if (!(await askConfirm({ mode: data.mode, unverifiedConnection: data.unverifiedConnection }))) {
    return { status: 'cancelled' };
  }
  const attemptKey = `activate-${storeId}-${provider}-${crypto.randomUUID()}`;
  const done = await apiRequest<{ activated: true }>(`${root}/confirm`, {
    method: 'POST',
    headers: { 'Idempotency-Key': attemptKey },
    body: JSON.stringify({ confirmToken: data.confirmToken }),
  });
  if (done.error) {
    return { status: 'error', code: done.error.code, message: done.error.message };
  }
  return { status: 'activated', mode: data.mode, unverifiedConnection: data.unverifiedConnection };
}
