import { PLATFORM_MARKETING_URL } from '../lib/platform';

/**
 * 404 for the bare platform host (`store.force-ai.co/<unknown-slug>`).
 *
 * This used to render the full platform marketing landing. It no longer does:
 * that page moved to force-ai.co, and serving it here gave every unknown URL a
 * 200-looking marketing page competing with the real site.
 *
 * It stays a real 404 rather than a redirect — a redirect on a non-existent URL
 * is a soft-404, and search engines treat it as one.
 *
 * A MERCHANT's 404 never reaches this component; `app/not-found.tsx` routes
 * store context to `StoreNotFound` so a merchant's customer is never shown the
 * platform at all.
 */
export function PlatformNotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-white px-6 text-center">
      <p className="font-mono text-xs uppercase tracking-[0.18em] text-neutral-400">404</p>
      <h1 className="mt-4 text-2xl font-bold tracking-tight text-neutral-900 sm:text-3xl">
        This page doesn’t exist
      </h1>
      <p className="mt-3 max-w-sm text-[15px] leading-relaxed text-neutral-500">
        The store you’re looking for may have moved, or the link may be wrong.
      </p>
      <a
        href={PLATFORM_MARKETING_URL}
        className="mt-8 inline-flex items-center rounded-sm bg-[#FF6E01] px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-[#E45F00] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#C04E00]"
      >
        Go to Force AI
      </a>
    </main>
  );
}
