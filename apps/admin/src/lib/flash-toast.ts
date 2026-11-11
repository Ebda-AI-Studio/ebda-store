/**
 * A success message that must survive a redirect (QA-B1: «احفظ المنتج» went back to the list with no sign it saved).
 * The saving page calls `queueFlashToast()` right before `router.push`; `FlashToast` (mounted once under the
 * ToastProvider) shows it after the destination route has rendered, so it never depends on the toast surviving the
 * route change. sessionStorage is a per-tab convenience: when it is unavailable the message is simply not shown.
 */
const KEY = 'ebda-admin-flash-toast';

export function queueFlashToast(title: string): void {
  try {
    window.sessionStorage.setItem(KEY, title);
  } catch {
    /* private mode or blocked storage: no flash, the redirect still happens */
  }
}

export function takeFlashToast(): string | null {
  try {
    const title = window.sessionStorage.getItem(KEY);
    if (title !== null) window.sessionStorage.removeItem(KEY);
    return title;
  } catch {
    return null;
  }
}
