import * as Sentry from '@sentry/node';
import { nodeProfilingIntegration } from '@sentry/profiling-node';
import { Request, Response, NextFunction } from 'express';
import { config } from '../config';
import logger from '../lib/logger';

// ==========================================
// Sentry Error Monitoring Service (v8 API)
// ==========================================

export class SentryService {
  private static isInitialized = false;

  /**
   * Initialize Sentry
   */
  static init(): void {
    if (this.isInitialized) {
      return;
    }

    if (!config.sentryDsn) {
      logger.info('[SENTRY] DSN not configured, skipping initialization');
      return;
    }

    Sentry.init({
      dsn: config.sentryDsn,
      environment: config.nodeEnv,
      release: config.appVersion || '1.0.0',

      integrations: [nodeProfilingIntegration()],

      // Performance sampling
      tracesSampleRate: config.nodeEnv === 'production' ? 0.1 : 1.0,
      profilesSampleRate: config.nodeEnv === 'production' ? 0.1 : 1.0,

      // Don't send errors in development by default
      enabled: config.nodeEnv !== 'development' || config.sentryDebug,

      // Ignore certain errors
      ignoreErrors: ['RATE_LIMITED', 'UNAUTHORIZED', 'NOT_FOUND', 'ValidationError'],
    });

    this.isInitialized = true;
    logger.info('[SENTRY] Initialized');
  }

  /**
   * Express error handler middleware
   *
   * SECURITY: Authorization + Cookie headers are stripped before sending to
   * Sentry. Pino's redact list does NOT protect Sentry's `extra` payload;
   * without this scrub every 5xx error pipes live JWTs / session cookies to
   * a third-party SaaS. 2026-05-22 audit P0-3.
   */
  static errorHandler() {
    return (
      err: Error & { status?: number; statusCode?: number },
      req: Request,
      _res: Response,
      next: NextFunction
    ) => {
      // AppError carries `statusCode` (not `status`); reading only `err.status`
      // made every 4xx (validation/auth/not-found) satisfy `!err.status` and get
      // captured — the source of the 4957x/242x/115x Sentry noise. Prefer
      // statusCode, fall back to status; capture only 5xx or unknown-code errors
      // (no code = a genuine uncaught crash, which we DO want). 2026-06-10 audit F1.
      const code = err.statusCode ?? err.status;
      if (this.isInitialized && (!code || code >= 500)) {
        const { authorization, cookie, 'x-csrf-token': csrfToken, ...safeHeaders } = req.headers;
        // suppress unused-var warning — these are intentionally dropped
        void authorization;
        void cookie;
        void csrfToken;
        Sentry.captureException(err, {
          extra: {
            url: req.url,
            method: req.method,
            headers: safeHeaders,
          },
        });
      }
      next(err);
    };
  }

  /**
   * Capture an exception
   */
  static captureException(
    error: Error,
    context?: {
      user?: { id: string; email?: string };
      tags?: Record<string, string>;
      extra?: Record<string, unknown>;
    }
  ): string {
    if (!this.isInitialized) {
      logger.error({ err: error }, '[SENTRY] Not initialized, logging error');
      return '';
    }

    // SECURITY: drop email from Sentry user context (GDPR/KW Law 13/2023 —
    // customer email shouldn't reach a US SaaS without explicit consent for
    // error-tracking). 2026-05-22 audit P2.
    return Sentry.captureException(error, {
      user: context?.user ? { id: context.user.id } : undefined,
      tags: context?.tags,
      extra: context?.extra,
    });
  }

  /**
   * Capture a message
   */
  static captureMessage(
    message: string,
    level: 'info' | 'warning' | 'error' = 'info',
    context?: {
      tags?: Record<string, string>;
      extra?: Record<string, unknown>;
    }
  ): string {
    if (!this.isInitialized) {
      logger.info({ level, message }, '[SENTRY] Not initialized, logging message');
      return '';
    }

    return Sentry.captureMessage(message, {
      level,
      tags: context?.tags,
      extra: context?.extra,
    });
  }

  /**
   * Set user context for the current scope. Email is intentionally dropped
   * from the payload — Sentry only sees the user ID and role, never PII.
   * 2026-05-22 audit P2.
   */
  static setUser(user: { id: string; email?: string; role?: string }): void {
    if (!this.isInitialized) return;
    Sentry.setUser({ id: user.id, role: user.role });
  }

  /**
   * Clear user context
   */
  static clearUser(): void {
    if (!this.isInitialized) return;
    Sentry.setUser(null);
  }

  /**
   * Add breadcrumb for debugging
   */
  static addBreadcrumb(breadcrumb: {
    category: string;
    message: string;
    level?: 'debug' | 'info' | 'warning' | 'error';
    data?: Record<string, unknown>;
  }): void {
    if (!this.isInitialized) return;
    Sentry.addBreadcrumb({
      category: breadcrumb.category,
      message: breadcrumb.message,
      level: breadcrumb.level || 'info',
      data: breadcrumb.data,
    });
  }

  /**
   * Middleware to add user context from request. Email NOT forwarded —
   * Sentry only sees userId + role. 2026-05-22 audit P2.
   */
  static userContextMiddleware() {
    return (req: Request, _res: Response, next: NextFunction) => {
      if (req.user) {
        SentryService.setUser({
          id: req.user.userId,
          role: req.user.role,
        });
      }
      next();
    };
  }

  /**
   * Flush pending events before shutdown
   */
  static async close(timeout = 2000): Promise<void> {
    if (!this.isInitialized) return;
    await Sentry.close(timeout);
  }
}
