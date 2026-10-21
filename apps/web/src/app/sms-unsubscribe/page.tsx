import type { Metadata } from 'next';
import { localizedMetadata } from '@/lib/seo/localized-metadata';
import { API_URL } from '../../lib/api';
import SmsUnsubscribeClient, { type SmsUnsubscribeInfo } from './SmsUnsubscribeClient';

// Token-specific and never cacheable — same rationale as /unsubscribe.
export const dynamic = 'force-dynamic';

export function generateMetadata(): Promise<Metadata> {
  return localizedMetadata({
    title: ['SMS preferences', 'تفضيلات الرسائل'],
    robots: { index: false, follow: false },
  });
}

interface PageProps {
  searchParams: Promise<{ t?: string }>;
}

/**
 * Landing page for the opt-out link in every promotional SMS (issue 206).
 * The server render only VALIDATES the token (GET); the opt-out happens when
 * the shopper presses the button (POST), because link previews in messaging
 * apps fetch GET URLs on their own. The API owns everything.
 */
export default async function SmsUnsubscribePage({ searchParams }: PageProps) {
  const { t: token } = await searchParams;
  let info: SmsUnsubscribeInfo | null = null;
  let error: 'INVALID_TOKEN' | 'NETWORK' | null = null;

  if (!token) {
    error = 'INVALID_TOKEN';
  } else {
    try {
      const res = await fetch(
        `${API_URL}/public/sms-consent/unsubscribe?t=${encodeURIComponent(token)}`,
        { cache: 'no-store' }
      );
      const body = await res.json().catch(() => null);
      if (res.ok && body?.success) info = body.data as SmsUnsubscribeInfo;
      else error = res.status >= 500 ? 'NETWORK' : 'INVALID_TOKEN';
    } catch {
      error = 'NETWORK';
    }
  }

  return <SmsUnsubscribeClient token={token ?? ''} info={info} error={error} />;
}
