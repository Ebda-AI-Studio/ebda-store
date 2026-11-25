import type { NextFunction, Request, Response } from 'express';

/**
 * `GET /auth/me?probe=guest` from a browser that carries NO credential at all (no `token` cookie, no
 * `refresh_token` cookie, no bearer) is a guest asking "who am I?": answer 200 `{ user: null }`, not a 401 the
 * browser prints as a red console error on every guest page. A request with ANY credential, or without the
 * probe flag, falls through to `authenticate` unchanged, so the 401 -> refresh -> retry flow for real and
 * expired sessions is untouched. Nothing is read or verified here; this only declines to 401 an empty request.
 */
export function guestProbe(req: Request, res: Response, next: NextFunction) {
  const empty =
    req.query.probe === 'guest' &&
    !!req.cookies &&
    !req.cookies.token &&
    !req.cookies.refresh_token &&
    !req.headers.authorization;
  if (!empty) return next();
  res.json({ success: true, data: { user: null } });
}
