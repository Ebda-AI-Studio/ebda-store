import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { AppError } from './error-handler';

export interface AuthPayload {
  userId: string;
  email: string;
  role: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthPayload;
  }
}

/**
 * Extract token from Authorization header or HTTP-only cookie.
 * The header takes precedence; the cookie is a fallback for
 * browser-based requests that rely on cookie-based auth.
 */
function extractToken(req: Request): string | undefined {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.split(' ')[1];
  }

  // Fallback: check HTTP-only cookie set by login/register routes
  const cookieToken = req.cookies?.token as string | undefined;
  if (cookieToken) {
    return cookieToken;
  }

  return undefined;
}

export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  const token = extractToken(req);

  if (!token) {
    throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  }

  try {
    const payload = jwt.verify(token, config.jwtSecret, {
      algorithms: ['HS256'],
      issuer: 'force-api',
      audience: 'force-app',
    }) as AuthPayload & { type?: string };

    // Reject refresh tokens used as access tokens
    if (payload.type === 'refresh') {
      throw new AppError(401, 'TOKEN_INVALID', 'Refresh tokens cannot be used for authentication');
    }

    req.user = payload;
    next();
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(401, 'TOKEN_INVALID', 'Invalid or expired token');
  }
}

/**
 * Optional authentication - sets req.user if valid token provided, but doesn't require it
 */
export function optionalAuthenticate(req: Request, _res: Response, next: NextFunction): void {
  const token = extractToken(req);

  if (!token) {
    // No token provided, continue without user
    next();
    return;
  }

  try {
    const payload = jwt.verify(token, config.jwtSecret, {
      algorithms: ['HS256'],
      issuer: 'force-api',
      audience: 'force-app',
    }) as AuthPayload;
    req.user = payload;
  } catch {
    // Invalid token, continue without user
  }

  next();
}

export function authorize(...roles: string[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
    }

    if (!roles.includes(req.user.role)) {
      throw new AppError(403, 'FORBIDDEN', 'Insufficient permissions');
    }

    next();
  };
}
