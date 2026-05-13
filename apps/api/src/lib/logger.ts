import pino from 'pino';
import { config } from '../config';

export const logger = pino({
  level: config.nodeEnv === 'production' ? 'info' : 'debug',
  transport:
    config.nodeEnv !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } }
      : undefined,
  base: { env: config.nodeEnv },
  // Redact PII + secrets from structured logs. Auth headers cover token
  // leakage; the body.* + wildcard paths cover request payloads that
  // get serialised into error logs (e.g. `logger.error({ err, body })`).
  // Pino's wildcard syntax is `*.field` — matches any object depth.
  redact: [
    'req.headers.authorization',
    'req.headers.cookie',
    'req.headers["x-csrf-token"]',
    'req.body.password',
    'req.body.currentPassword',
    'req.body.newPassword',
    'req.body.token',
    'req.body.cardNumber',
    'req.body.cvv',
    'req.body.cvc',
    '*.password',
    '*.passwordHash',
    '*.token',
    '*.accessToken',
    '*.refreshToken',
    '*.apiKey',
    '*.secret',
    '*.cvv',
    '*.cardNumber',
  ],
});

export default logger;
