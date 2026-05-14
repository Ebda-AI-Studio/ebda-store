import pino, { type TransportTargetOptions } from 'pino';
import { config } from '../config';

const betterStackToken = process.env.BETTERSTACK_SOURCE_TOKEN;
const betterStackHost = process.env.BETTERSTACK_INGESTING_HOST;

const targets: TransportTargetOptions[] = [];

if (config.nodeEnv === 'production') {
  targets.push({ target: 'pino/file', options: { destination: 1 }, level: 'info' });
} else {
  targets.push({
    target: 'pino-pretty',
    options: { colorize: true, translateTime: 'HH:MM:ss', destination: 1 },
    level: 'debug',
  });
}

if (betterStackToken && betterStackHost) {
  targets.push({
    target: '@logtail/pino',
    options: { sourceToken: betterStackToken, options: { endpoint: betterStackHost } },
    level: 'info',
  });
}

export const logger = pino(
  {
    level: config.nodeEnv === 'production' ? 'info' : 'debug',
    base: { env: config.nodeEnv },
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
  },
  pino.transport({ targets })
);

export default logger;
