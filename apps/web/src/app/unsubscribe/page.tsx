import type { Metadata } from 'next';
import { API_URL } from '../../lib/api';
import UnsubscribeClient, { type UnsubscribeInfo } from './UnsubscribeClient';

// Token-specific and never cacheable — same Track-B rationale as /review.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Unsubscribe',
  robots: { index: false, follow: false },
};

interface PageProps {
  searchParams: Promise<{ token?: string }>;
}

/**
 * Landing page for the unsubscribe link in every campaign email (D2). The
 * server render only VALIDATES the token (GET); unsubscribing happens when the
 * shopper presses the button (POST), because link scanners and mail-client
 * previews fetch GET URLs on their own. The API owns everything — this page
 * holds no logic beyond showing the result.
 */
export default async function UnsubscribePage({ searchParams }: PageProps) {
  const { token } = await searchParams;
  let info: UnsubscribeInfo | null = null;
  let error: 'INVALID_TOKEN' | 'NETWORK' | null = null;

  if (!token) {
    error = 'INVALID_TOKEN';
  } else {
    try {
      // API_URL already includes the /api/v1 prefix (see lib/api.ts).
      const res = await fetch(
        `${API_URL}/public/campaigns/unsubscribe?token=${encodeURIComponent(token)}`,
        { cache: 'no-store' }
      );
      const body = await res.json().catch(() => null);
      if (res.ok && body?.success) info = body.data as UnsubscribeInfo;
      else error = res.status >= 500 ? 'NETWORK' : 'INVALID_TOKEN';
    } catch {
      error = 'NETWORK';
    }
  }

  return <UnsubscribeClient token={token ?? ''} info={info} error={error} />;
}
