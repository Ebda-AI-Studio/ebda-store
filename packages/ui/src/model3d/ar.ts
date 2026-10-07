/**
 * AR hand-off helpers (no three.js here — safe to import anywhere and to unit
 * test). iOS: Quick Look via `<a rel="ar">`. Android: Google Scene Viewer intent.
 */
export type ArPlatform = 'ios' | 'android' | 'none';

export function arPlatform(
  doc: Pick<Document, 'createElement'> | undefined = typeof document === 'undefined'
    ? undefined
    : document,
  ua: string = typeof navigator === 'undefined' ? '' : navigator.userAgent
): ArPlatform {
  if (!doc) return 'none';
  const a = doc.createElement('a') as HTMLAnchorElement;
  if (a.relList && typeof a.relList.supports === 'function' && a.relList.supports('ar')) {
    return 'ios';
  }
  if (/android/i.test(ua) && !/iphone|ipad|ipod/i.test(ua)) return 'android';
  return 'none';
}

/**
 * Scene Viewer intent URL. Only an https GLB can go here (Google fetches it
 * server-side, so no CORS is involved). `fallbackUrl` is where Chrome returns
 * when the Google app is missing.
 */
export function sceneViewerIntent(glbUrl: string, title: string, fallbackUrl: string): string {
  const params = new URLSearchParams({ file: glbUrl, mode: 'ar_preferred', title });
  return (
    `intent://arvr.google.com/scene-viewer/1.0?${params.toString()}` +
    '#Intent;scheme=https;package=com.google.android.googlequicksearchbox;' +
    'action=android.intent.action.VIEW;' +
    `S.browser_fallback_url=${encodeURIComponent(fallbackUrl)};end;`
  );
}
