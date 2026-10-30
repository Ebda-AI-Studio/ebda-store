/**
 * Whether the protected app shell may paint (Ruling AUTH-FLASH-1).
 *
 * Without this, a logged-out visitor saw the dashboard skeleton, then one frame of the real
 * dashboard (`isLoading=false`, `user=null`) before the redirect effect pushed /login. The shell
 * may paint only once a session is known; until then, and while the redirect to /login is in
 * flight, a neutral loader stands in. Public pages (login, signup, ...) always render.
 */
export function shouldRenderShell(args: {
  isLoading: boolean;
  hasUser: boolean;
  isPublic: boolean;
}): boolean {
  if (args.isPublic) return true;
  return !args.isLoading && args.hasUser;
}
