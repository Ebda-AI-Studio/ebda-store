/**
 * OpenTelemetry distributed tracing bootstrap (descoped follow-up to #97).
 *
 * MUST be the FIRST import in index.ts — OTel auto-instrumentation patches
 * `http`, `express`, `pg`, `ioredis` etc. at require-time, so the SDK has to
 * start before those modules are imported anywhere.
 *
 * Opt-in + fail-open: tracing only activates when `OTEL_EXPORTER_OTLP_ENDPOINT`
 * is set (e.g. a Grafana/Tempo/Honeycomb/Jaeger OTLP collector). With no
 * endpoint — or if anything throws during init — the API boots completely
 * normally and this is a no-op. Tracing is observability; it must never be able
 * to take the API down.
 *
 * Env:
 *   OTEL_EXPORTER_OTLP_ENDPOINT   collector base URL (e.g. https://otlp.example:4318)
 *   OTEL_EXPORTER_OTLP_HEADERS    optional "key=val,key2=val2" auth headers
 *   OTEL_SERVICE_NAME             service name (default "force-api")
 *   OTEL_TRACES_SAMPLER_ARG       head sample ratio 0..1 (default 0.1 in prod, 1 otherwise)
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { ParentBasedSampler, TraceIdRatioBasedSampler } from '@opentelemetry/sdk-trace-base';

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

let sdk: NodeSDK | undefined;

if (endpoint) {
  try {
    const headers = parseHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS);
    const isProd = process.env.NODE_ENV === 'production';
    const ratio = clampRatio(process.env.OTEL_TRACES_SAMPLER_ARG, isProd ? 0.1 : 1.0);

    sdk = new NodeSDK({
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || 'force-api',
        [ATTR_SERVICE_VERSION]: process.env.APP_VERSION || '1.0.0',
      }),
      sampler: new ParentBasedSampler({
        root: new TraceIdRatioBasedSampler(ratio),
      }),
      traceExporter: new OTLPTraceExporter({
        // OTLP/HTTP expects the traces path appended to the base endpoint.
        url: `${endpoint.replace(/\/$/, '')}/v1/traces`,
        headers,
      }),
      instrumentations: [
        getNodeAutoInstrumentations({
          // fs spans are extremely noisy and never useful for request tracing.
          '@opentelemetry/instrumentation-fs': { enabled: false },
        }),
      ],
    });

    sdk.start();
    // eslint-disable-next-line no-console
    console.log(`[otel] tracing enabled → ${endpoint} (sample ${ratio})`);

    const shutdown = () => {
      sdk
        ?.shutdown()
        .catch(() => {})
        .finally(() => process.exit(0));
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  } catch (err) {
    // Never let tracing break the API. Log and continue un-instrumented.
    // eslint-disable-next-line no-console
    console.warn('[otel] tracing init failed; continuing without it:', (err as Error).message);
  }
} else {
  // eslint-disable-next-line no-console
  console.log('[otel] OTEL_EXPORTER_OTLP_ENDPOINT not set — tracing disabled');
}

function parseHeaders(raw?: string): Record<string, string> | undefined {
  if (!raw) return undefined;
  const out: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const i = pair.indexOf('=');
    if (i > 0) out[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  return Object.keys(out).length ? out : undefined;
}

function clampRatio(raw: string | undefined, fallback: number): number {
  const n = raw === undefined ? NaN : Number(raw);
  if (Number.isFinite(n) && n >= 0 && n <= 1) return n;
  return fallback;
}

export { sdk };
