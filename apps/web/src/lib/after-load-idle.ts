/**
 * Run `cb` once the page has finished loading and the browser is idle, or
 * earlier on the first user interaction - whichever comes first (docs/RULINGS.md
 * PERF-STORE-2). Used to keep third-party tags (OneSignal) and other
 * non-critical work out of the load that decides LCP/FCP without making them
 * wait for a user who never touches the page: `timeout` bounds the idle wait.
 *
 * Returns a cancel function. No-op on the server.
 */
const INTERACTION_EVENTS = ['pointerdown', 'keydown', 'touchstart', 'scroll'] as const;

export function afterLoadIdle(cb: () => void, timeoutMs = 4000): () => void {
  if (typeof window === 'undefined') return () => undefined;
  let done = false;
  let idleHandle: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const cleanup = () => {
    for (const ev of INTERACTION_EVENTS) window.removeEventListener(ev, run);
    window.removeEventListener('load', onLoad);
    if (idleHandle !== undefined && 'cancelIdleCallback' in window)
      window.cancelIdleCallback(idleHandle);
    if (timer !== undefined) clearTimeout(timer);
  };
  function run() {
    if (done) return;
    done = true;
    cleanup();
    cb();
  }
  function onLoad() {
    if ('requestIdleCallback' in window)
      idleHandle = window.requestIdleCallback(run, { timeout: timeoutMs });
    else timer = setTimeout(run, Math.min(timeoutMs, 2500));
  }

  for (const ev of INTERACTION_EVENTS)
    window.addEventListener(ev, run, { once: true, passive: true });
  if (document.readyState === 'complete') onLoad();
  else window.addEventListener('load', onLoad, { once: true });

  return () => {
    done = true;
    cleanup();
  };
}
