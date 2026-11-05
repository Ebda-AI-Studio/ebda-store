/**
 * P0 logout audit: the realtime socket used to read `localStorage.accessToken` (absent after an accounts sign-in), never
 * refreshed, and retried five times then died. socket.io calls an `auth` function on EVERY (re)connect, so each attempt
 * takes a fresh token from the same source as the rest of the app. A revoked session stops the socket for good.
 */
export interface SocketAuthDeps {
  /** A fresh access token; null = the session is gone (revoked); throws = transient (throttle, offline). */
  getToken: () => Promise<string | null>;
  onRevoked: () => void;
}

export function makeSocketAuth(deps: SocketAuthDeps) {
  let revoked = false;
  return async (cb: (data: { token?: string }) => void): Promise<void> => {
    if (revoked) return cb({});
    try {
      const token = await deps.getToken();
      if (token === null) {
        revoked = true;
        deps.onRevoked();
        return cb({});
      }
      cb({ token });
    } catch {
      // Transient: connect without a token (the cookie may still authenticate) and let socket.io retry.
      cb({});
    }
  };
}
