import { ShopChrome } from '../../components';

/**
 * Search-page loading skeleton. Wrapped in ShopChrome so the header +
 * footer render during the streaming gap. Without the chrome, only the
 * inner skeleton rendered while waiting — and the layout-level cookie
 * preferences fallback (in `app/layout.tsx`) ended up visible alone at
 * the top of the viewport, so users saw "Cookie Preferences" flash on
 * its own during every search-page load.
 */
export default function Loading() {
  return (
    <ShopChrome>
      <div
        data-loading
        className="container mx-auto min-h-[50svh] max-w-7xl sm:min-h-[70svh] px-4 py-8 flex-1"
      >
        <div className="animate-pulse space-y-4">
          <div className="h-8 w-48 bg-muted rounded" />
          <div className="h-10 w-full max-w-2xl mx-auto bg-muted rounded-lg" />
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 pt-4">
            <div className="h-64 bg-muted rounded-lg" />
            <div className="h-64 bg-muted rounded-lg" />
            <div className="h-64 bg-muted rounded-lg" />
            <div className="h-64 bg-muted rounded-lg" />
          </div>
        </div>
      </div>
    </ShopChrome>
  );
}
