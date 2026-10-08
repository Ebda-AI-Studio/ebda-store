'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '../../lib/api';

export interface ReceiptApiError {
  code: string;
  message: string;
  status: number;
}

/** Codes the receipt endpoints answer with that have their own copy (instapayReceipt.errors.*). */
const KNOWN_ERRORS = new Set([
  'DUPLICATE_REFERENCE',
  'INVALID_FILE_TYPE',
  'FILE_TOO_LARGE',
  'TOO_MANY_RECEIPTS',
  'RATE_LIMITED',
  'PRIVATE_STORAGE_NOT_CONFIGURED',
]);

/** i18n key (under `instapayReceipt.errors`) for an API error; unknown codes get the generic line. */
export function receiptErrorKey(code: string | undefined): string {
  if (code === 'TOO_MANY_RECEIPTS') return 'RATE_LIMITED';
  return code && KNOWN_ERRORS.has(code) ? code : 'GENERIC';
}

/**
 * POST a multipart body through `apiFetch` (the JSON helpers force a JSON
 * content type) and unwrap the API's `{ success, data, error }` envelope.
 */
export async function postMultipart<T>(
  endpoint: string,
  form: FormData
): Promise<{ data: T | null; error: ReceiptApiError | null }> {
  try {
    const res = await apiFetch(endpoint, { method: 'POST', body: form });
    const body = (await res.json().catch(() => null)) as {
      data?: T;
      error?: { code?: string; message?: string };
    } | null;
    if (!res.ok || !body?.data) {
      return {
        data: null,
        error: {
          code: body?.error?.code ?? 'REQUEST_FAILED',
          message: body?.error?.message ?? '',
          status: res.status,
        },
      };
    }
    return { data: body.data, error: null };
  } catch {
    return { data: null, error: { code: 'NETWORK', message: '', status: 0 } };
  }
}

/**
 * Fetch a private image (a payment screenshot) with the session credentials and
 * expose it as an object URL. Never a public URL: the bytes are only ever held
 * in this tab. The URL is revoked when the endpoint changes or the view unmounts.
 */
export function useBlobUrl(endpoint: string | null): {
  url: string | null;
  loading: boolean;
  failed: boolean;
} {
  const [state, setState] = useState<{ url: string | null; loading: boolean; failed: boolean }>({
    url: null,
    loading: !!endpoint,
    failed: false,
  });

  useEffect(() => {
    if (!endpoint) {
      setState({ url: null, loading: false, failed: false });
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    setState({ url: null, loading: true, failed: false });
    (async () => {
      try {
        const res = await apiFetch(endpoint);
        if (!res.ok) throw new Error(String(res.status));
        const blob = await res.blob();
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setState({ url: objectUrl, loading: false, failed: false });
      } catch {
        if (!cancelled) setState({ url: null, loading: false, failed: true });
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [endpoint]);

  return state;
}
