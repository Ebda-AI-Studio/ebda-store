/**
 * The admin origins allowed to drive the builder canvas over postMessage.
 * Deliberately the SAME list (same env var, same defaults) as the
 * storefront's CSP `frame-ancestors` in `apps/web/next.config.js`: a window
 * that may frame the storefront is the only one that may talk to the
 * canvas. `tests/unit/builder-preview-canvas.test.ts` pins the two together.
 */
export function allowedParentOrigins(
  env: { STOREFRONT_FRAME_ANCESTORS?: string; NODE_ENV?: string } = process.env
): string[] {
  const raw =
    env.STOREFRONT_FRAME_ANCESTORS ??
    (env.NODE_ENV === 'production'
      ? 'https://store.ebda.app'
      : 'https://store.ebda.app http://localhost:3001 http://localhost:3000');
  return raw.split(/\s+/).filter(o => /^https?:\/\/[^/\s]+$/.test(o));
}
