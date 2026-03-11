import { Request } from 'express';
import { AuthPayload } from '../middleware/auth';

/**
 * Safely extract the authenticated user from the request.
 * Throws if `req.user` is not set (i.e. the route was not protected by `authenticate` middleware).
 *
 * Use this instead of `req.user!` to avoid non-null assertions.
 */
export function getAuthUser(req: Request): AuthPayload {
  if (!req.user) {
    throw new Error('Authentication required — this route must use the authenticate middleware');
  }
  return req.user;
}
