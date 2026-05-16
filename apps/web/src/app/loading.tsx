import { ShopChrome } from '../components';

/**
 * Root-level loading fallback. Wrapped in ShopChrome so header/footer
 * render during the streaming gap — without the chrome, only this
 * spinner rendered while waiting, and the layout-level cookie-
 * preferences fallback (in `app/layout.tsx`) appeared alone at the top
 * of the viewport. Same pattern as `app/search/loading.tsx`.
 */
export default function Loading() {
  return (
    <ShopChrome>
      {/* data-loading marker is the signal layout.tsx watches for via
          `body:has([data-loading])` to hide the SSR cookie-prefs link
          during loading screens — Ahmad 2026-05-16. */}
      <div data-loading className="flex min-h-[50vh] items-center justify-center flex-1">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    </ShopChrome>
  );
}
