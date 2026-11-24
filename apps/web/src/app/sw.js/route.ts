import { getStore } from '../../lib/store-resolver';
import { isStorefrontPwaActive } from '../../lib/pwa/pwa-active';
import { KILL_SW, REAL_SW } from '../../lib/pwa/sw-source';

/**
 * `/sw.js`: the real worker while the store's phone app is on, a kill-switch worker (install -> skipWaiting;
 * activate -> clear caches, claim, unregister) while it is off (PW1). Browsers that registered the real worker
 * before the merchant switched it off pick the kill-switch up on their next update check, so they stop serving
 * cached pages. `no-cache` because a worker script must be revalidated on every update check.
 */
export async function GET(): Promise<Response> {
  const store = await getStore();
  return new Response(isStorefrontPwaActive(store) ? REAL_SW : KILL_SW, {
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-cache, max-age=0, must-revalidate',
      'Service-Worker-Allowed': '/',
    },
  });
}
