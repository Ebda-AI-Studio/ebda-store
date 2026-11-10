/**
 * A pino-shaped logger that writes one JSON line per call to the console.
 *
 * Workers cannot run pino's transports (they are `worker_threads`), and Workers Logs
 * / Logpush already collect console output as structured JSON, so on Workers the
 * logger is this: the same call shapes the API uses everywhere
 * (`logger.info(msg)`, `logger.error({ err, ...ctx }, msg)`, `child()`), the same
 * redaction list, level filtering, and `Error` serialisation (`err` -> {type,
 * message, stack}). Node keeps pino.
 */

type Level = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

const ORDER: Record<Level, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

/** Same list as the pino logger's `redact` (path form collapses to the key name). */
const REDACT_KEYS = new Set([
  'authorization',
  'cookie',
  'x-csrf-token',
  'x-ebda-ssr-auth',
  'password',
  'currentPassword',
  'newPassword',
  'token',
  'cardNumber',
  'cvv',
  'cvc',
  'passwordHash',
  'accessToken',
  'refreshToken',
  'apiKey',
  'secret',
]);

const CENSOR = '[Redacted]';
const MAX_DEPTH = 6;

function serializeError(err: Error): Record<string, unknown> {
  return {
    type: err.name,
    message: err.message,
    stack: err.stack,
    ...(err.cause !== undefined ? { cause: serialize(err.cause, 1) } : {}),
  };
}

function serialize(value: unknown, depth: number): unknown {
  if (value instanceof Error) return serializeError(value);
  if (value === null || typeof value !== 'object') {
    return typeof value === 'bigint' ? value.toString() : value;
  }
  if (depth >= MAX_DEPTH) return '[Truncated]';
  if (Array.isArray(value)) return value.map(v => serialize(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = REDACT_KEYS.has(k) ? CENSOR : serialize(v, depth + 1);
  }
  return out;
}

export interface ConsoleLoggerOptions {
  level?: Level | 'silent';
  base?: Record<string, unknown>;
}

export interface ConsoleLogger {
  level: string;
  trace: LogFn;
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  fatal: LogFn;
  child(bindings: Record<string, unknown>): ConsoleLogger;
  isLevelEnabled(level: string): boolean;
}

type LogFn = (objOrMsg?: unknown, msg?: string, ...rest: unknown[]) => void;

export function createConsoleLogger(
  opts: ConsoleLoggerOptions = {},
  bindings: Record<string, unknown> = {}
): ConsoleLogger {
  const threshold = opts.level === 'silent' ? Infinity : ORDER[opts.level ?? 'info'];
  const base = { ...opts.base, ...bindings };

  const emit = (level: Level, objOrMsg: unknown, msg?: string, rest: unknown[] = []): void => {
    if (ORDER[level] < threshold) return;
    let fields: Record<string, unknown> = {};
    let message: string | undefined;
    if (objOrMsg instanceof Error) {
      fields = { err: serializeError(objOrMsg) };
      message = msg ?? objOrMsg.message;
    } else if (objOrMsg !== null && typeof objOrMsg === 'object') {
      fields = serialize(objOrMsg, 0) as Record<string, unknown>;
      message = msg;
    } else if (objOrMsg !== undefined) {
      message = String(objOrMsg);
    }
    if (message && rest.length > 0 && message.includes('%')) {
      // pino's printf-style interpolation, for the few call sites that use it.
      let i = 0;
      message = message.replace(/%[sdjo]/g, () => String(rest[i++]));
    }
    const line = JSON.stringify({
      level,
      time: new Date().toISOString(),
      ...base,
      ...fields,
      ...(message !== undefined ? { msg: message } : {}),
    });
    // Workers Logs maps console.error / warn / log to levels; pick the sink, then write.
    const sink =
      ORDER[level] >= ORDER.error ? console.error : level === 'warn' ? console.warn : console.log;
    sink(line);
  };

  const fn =
    (level: Level): LogFn =>
    (objOrMsg, msg, ...rest) =>
      emit(level, objOrMsg, msg, rest);

  return {
    level: opts.level ?? 'info',
    trace: fn('trace'),
    debug: fn('debug'),
    info: fn('info'),
    warn: fn('warn'),
    error: fn('error'),
    fatal: fn('fatal'),
    child: b => createConsoleLogger(opts, { ...bindings, ...b }),
    isLevelEnabled: l => ORDER[l as Level] >= threshold,
  };
}
