import * as Sentry from '@sentry/node';
import { nodeProfilingIntegration } from '@sentry/profiling-node';
import { Express, Request, Response, NextFunction } from 'express';
import { config } from '../config';

// ==========================================
// Sentry Error Monitoring Service
// ==========================================

export class SentryService {
  private static isInitialized = false;

  /**
   * Initialize Sentry
   */
  static init(app?: Express): void {
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
        // Performance monitoring
        nodeProfilingIntegration(),
      ],

      // Performance sampling
      tracesSampleRate: config.nodeEnv === 'production' ? 0.1 : 1.0,
      profilesSampleRate: config.nodeEnv === 'production' ? 0.1 : 1.0,

      // Don't send errors in development by default
      enabled: config.nodeEnv !== 'development' || config.sentryDebug,

      // Filter out sensitive data
      beforeSend(event, hint) {
        // Remove sensitive headers
        if (event.request?.headers) {
          delete event.request.headers.authorization;
          delete event.request.headers.cookie;
          delete event.request.headers['x-csrf-token'];
        }

        // Remove sensitive data from request body
        if (event.request?.data) {
          const sensitiveFields = ['password', 'passwordHash', 'token', 'secret', 'apiKey'];
          try {
            const data = typeof event.request.data === 'string'
              ? JSON.parse(event.request.data)
              : event.request.data;

            for (const field of sensitiveFields) {
              if (data[field]) {
                data[field] = '[REDACTED]';
              }
            }
            event.request.data = JSON.stringify(data);
          } catch {
            // Ignore parsing errors
          }
        }

        return event;
      },

      // Ignore certain errors
      ignoreErrors: [
        'RATE_LIMITED',
        'UNAUTHORIZED',
        'NOT_FOUND',
        'ValidationError',
      ],
    });

    if (app) {
      // Add Sentry request handler (must be first middleware)
      app.use(Sentry.Handlers.requestHandler());

      // Add tracing middleware
      app.use(Sentry.Handlers.tracingHandler());
    }

    this.isInitialized = true;
    console.log('[SENTRY] Initialized');
  }

  /**
   * Get Sentry error handler middleware
   * Must be added after all controllers but before other error handlers
   */
  static errorHandler() {
    return Sentry.Handlers.errorHandler({
      shouldHandleError(error) {
        // Capture all 500+ errors
        if (error.status && error.status >= 500) {
          return true;
        }
        // Don't capture 4xx errors (client errors)
        if (error.status && error.status < 500) {
          return false;
        }
        // Capture unhandled errors
        return true;
      },
    });
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

    Sentry.withScope((scope) => {
      if (context?.user) {
        scope.setUser({ id: context.user.id, email: context.user.email });
      }

      if (context?.tags) {
        for (const [key, value] of Object.entries(context.tags)) {
          scope.setTag(key, value);
        }
      }

      if (context?.extra) {
        for (const [key, value] of Object.entries(context.extra)) {
          scope.setExtra(key, value);
        }
      }
    });

    return Sentry.captureException(error);
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

    Sentry.withScope((scope) => {
      if (context?.tags) {
        for (const [key, value] of Object.entries(context.tags)) {
          scope.setTag(key, value);
        }
      }

      if (context?.extra) {
        for (const [key, value] of Object.entries(context.extra)) {
          scope.setExtra(key, value);
        }
      }
    });

    return Sentry.captureMessage(message, level);
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
   * Start a performance transaction
   */
  static startTransaction(
    name: string,
    op: string
  ): ReturnType<typeof Sentry.startSpan> | null {
    if (!this.isInitialized) return null;
    return Sentry.startSpan({ name, op }, () => {});
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
