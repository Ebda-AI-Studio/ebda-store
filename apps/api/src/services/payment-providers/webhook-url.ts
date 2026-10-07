/**
 * The payment webhook URL Ebda gives a gateway (per request) and shows the merchant (to paste
 * into the gateway's dashboard). Per store when the store is known:
 *
 *     <API_URL>/api/v1/webhooks/payment/<provider>/s/<storeId>
 *
 * The store in the URL is NOT trusted on its own: the route still resolves the owning store from
 * the payment reference in the body and refuses a delivery whose payment belongs to another store,
 * and the signature is verified with that store's secret. The path only makes the per-store
 * routing explicit and lets each merchant see "their" URL. Without a store (platform callers)
 * the legacy per-provider URL is used.
 */
import { config } from '../../config';

export function paymentWebhookUrl(provider: string, storeId?: string | null): string {
  const base = `${config.apiUrl.replace(/\/+$/, '')}/api/v1/webhooks/payment/${encodeURIComponent(provider)}`;
  return storeId ? `${base}/s/${encodeURIComponent(storeId)}` : base;
}
