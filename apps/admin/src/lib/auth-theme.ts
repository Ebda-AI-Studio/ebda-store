/**
 * The signed-out surfaces (sign-in, sign-up, password reset, email verification, invite, onboarding)
 * always render the light split layout: a white form beside the dark Nile panel. Ahmad's choice,
 * 2026-11-10. The rest of the admin stays dark-first with the saved `admin-theme` preference.
 *
 * Two halves, both needed:
 * - `THEME_INIT_SCRIPT` runs before first paint (root layout) and never adds `dark` on these paths,
 *   so a hard load does not flash black.
 * - `usePinnedLightTheme` (`use-pinned-light-theme.ts`) covers a client-side navigation onto these pages (e.g. sign-out from the
 *   dashboard, which leaves `html.dark` set) and restores the saved theme when the page unmounts.
 */
export const LIGHT_PINNED_PATH_SOURCE =
  '^/(login|signup|forgot-password|reset-password|verify-email|accept-invite|onboarding)(/|$)';

export const THEME_INIT_SCRIPT = `try{var s=localStorage.getItem('admin-theme');if(s!=='light'&&!new RegExp(${JSON.stringify(
  LIGHT_PINNED_PATH_SOURCE
)}).test(location.pathname)){document.documentElement.classList.add('dark')}}catch(e){}`;

export function isLightPinnedPath(pathname: string): boolean {
  return new RegExp(LIGHT_PINNED_PATH_SOURCE).test(pathname);
}
