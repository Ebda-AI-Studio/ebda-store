import * as Sentry from '@sentry/node';
import { nodeProfilingIntegration } from '@sentry/profiling-node';
import { Request, Response, NextFunction } from 'express';
import { config } from '../config';

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
      console.log('[SENTRY] DSN not configured, skipping initialization');
      return;
    }

    Sentry.init({
      dsn: config.sentryDsn,
      environment: config.nodeEnv,
      release: config.appVersion || '1.0.0',

      integrations: [
        nodeProfilingIntegration(),
      ],

      // Performance sampling
      tracesSampleRate: config.nodeEnv === 'production' ? 0.1 : 1.0,
      profilesSampleRate: config.nodeEnv === 'production' ? 0.1 : 1.0,

      // Don't send errors in development by default
      enabled: config.nodeEnv !== 'development' || config.sentryDebug,

      // Ignore certain errors
      ignoreErrors: [
        'RATE_LIMITED',
        'UNAUTHORIZED',
        'NOT_FOUND',
        'ValidationError',
      ],
    });

    this.isInitialized = true;
    console.log('[SENTRY] Initialized');
  }

  /**
   * Express error handler middleware
   */
  static errorHandler() {
    return (err: Error & { status?: number }, req: Request, _res: Response, next: NextFunction) => {
      if (this.isInitialized && (!err.status || err.status >= 500)) {
        Sentry.captureException(err, {
          extra: {
            url: req.url,
            method: req.method,
            headers: req.headers,
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
      console.error('[SENTRY] Not initialized, logging error:', error);
      return '';
    }

    return Sentry.captureException(error, {
      user: context?.user ? { id: context.user.id, email: context.user.email } : undefined,
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
      console.log(`[SENTRY] ${level.toUpperCase()}: ${message}`);
      return '';
    }

    return Sentry.captureMessage(message, {
      level,
      tags: context?.tags,
      extra: context?.extra,
    });
  }

  /**
   * Set user context for the current scope
   */
  static setUser(user: { id: string; email?: string; role?: string }): void {
    if (!this.isInitialized) return;
    Sentry.setUser(user);
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
   * Middleware to add user context from request
   */
  static userContextMiddleware() {
    return (req: Request, _res: Response, next: NextFunction) => {
      if (req.user) {
        SentryService.setUser({
          id: req.user.userId,
          email: req.user.email,
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

// Export Sentry for direct access if needed
export { Sentry };
