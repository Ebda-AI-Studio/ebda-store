import { config } from '../config';
import { signSubscriberUnsubscribeToken } from './campaign-unsubscribe-token';
import {
  listUnsubscribeHeaders,
  renderCampaignEmail,
  storefrontBaseUrl,
  type CampaignStoreContext,
} from '../services/campaign.service';

/**
 * One legacy-newsletter-broadcast email for ONE subscriber (Ruling
 * NEWSLETTER-UNSUB-1): the merchant body inside the branded shell, a bilingual
 * unsubscribe footer carrying that subscriber's signed one-click link, and the
 * RFC 8058 List-Unsubscribe / List-Unsubscribe-Post headers (https API only).
 * Locale follows the subscriber's language, like campaigns.
 */
export function buildBroadcastMessage(args: {
  store: CampaignStoreContext;
  subscriber: { id: string; email: string; language: string | null };
  subject: string;
  html: string;
  text?: string;
  hidePoweredBy?: boolean;
}): { to: string; html: string; text?: string; headers?: Record<string, string>; subject: string } {
  const { store, subscriber } = args;
  const locale: 'en' | 'ar' = subscriber.language === 'ar' ? 'ar' : 'en';
  const token = signSubscriberUnsubscribeToken(store.id, subscriber.id);
  const unsubscribeUrl = `${storefrontBaseUrl(store)}/unsubscribe?token=${encodeURIComponent(token)}`;
  const { subject, html } = renderCampaignEmail({
    store,
    locale,
    subject: args.subject,
    bodyHtml: args.html,
    unsubscribeUrl,
    hidePoweredBy: args.hidePoweredBy,
  });
  const text = args.text
    ? `${args.text}\n\n${locale === 'ar' ? 'إلغاء الاشتراك' : 'Unsubscribe'}: ${unsubscribeUrl}`
    : undefined;
  return {
    to: subscriber.email,
    subject,
    html,
    ...(text ? { text } : {}),
    headers: listUnsubscribeHeaders(config.apiUrl, token),
  };
}
