import pino, { type TransportTargetOptions } from 'pino';
import { config } from '../config';
import { isWorkers } from './runtime';
import { createConsoleLogger } from './console-logger';

function pinoLogger(): pino.Logger {
  // Axiom log drain — replaces the earlier BetterStack/@logtail/pino transport.
  // Axiom free tier: 500 GB ingest/month + 30-day retention (satisfies
  // CLAUDE.md rule 11). Same Pino multi-transport shape: stdout always +
  // remote sink when env vars are set. Graceful no-op when missing.
  const axiomToken = process.env.AXIOM_TOKEN;
  const axiomDataset = process.env.AXIOM_DATASET;

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

  if (axiomToken && axiomDataset) {
    // Pino transports run in a worker_threads.Worker — when the target is a
    // bare specifier the worker can't always resolve the ESM/CJS exports map
    // (depends on Node + npm hoisting). `require.resolve()` from the parent
    // process hands the worker an absolute file path, which always loads.
    targets.push({
      target: require.resolve('@axiomhq/pino'),
      options: { dataset: axiomDataset, token: axiomToken },
      level: 'info',
    });
  }

  return pino(
    {
      level: config.nodeEnv === 'production' ? 'info' : 'debug',
      base: { env: config.nodeEnv },
      redact: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-csrf-token"]',
        'req.headers["x-ebda-ssr-auth"]',
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
}

// Workers: no worker_threads transports and no Axiom pipe; one JSON line per call on
// the console, which Workers Logs / Logpush collect. Node keeps pino exactly as before.
const logger: pino.Logger = isWorkers
  ? (createConsoleLogger({
      level: config.nodeEnv === 'production' ? 'info' : 'debug',
      base: { env: config.nodeEnv },
    }) as unknown as pino.Logger)
  : pinoLogger();

export default logger;
