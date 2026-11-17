/**
 * Is the phone app (PWA) on for this storefront? ONE answer for every surface that makes a store
 * installable: the `<link rel="manifest">`, the manifest route, the service-worker registration and
 * the apple home-screen meta. PW1 (live QA 2026-11-17): the layout linked the manifest and the
 * route served it whatever the merchant's switch said, so a store with the switch OFF stayed
 * installable. Both the store's own switch AND the platform feature must be on.
 *
 * The platform-default store (`demo`, no merchant resolved) is Ebda itself and is not gated.
 */
export function isStorefrontPwaActive(store: {
  id?: string;
  pwaEnabled?: boolean;
  enabledFeatures?: readonly string[];
}): boolean {
  if (store.id === 'demo') return true;
  return store.pwaEnabled === true && (store.enabledFeatures?.includes('pwa') ?? true);
}
