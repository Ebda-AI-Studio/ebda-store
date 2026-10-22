// LOCAL ONLY (Task 14): the real API process with a FAKE embedding provider that injects latency.
// Never contacts Workers AI. Env: LAT_P50 / LAT_P95 (ms), LAT_SLOW (fraction of calls > the 400 ms
// budget), LAT_ERR (fraction of provider errors), STATS_FILE (JSON written on SIGTERM and every 5 s).
import { writeFileSync } from 'node:fs';
import { makeFakeProvider, type EmbedStats } from './fake-embed';
import { setEmbeddingProviderForTests } from '../../apps/api/src/lib/search/embedding-provider';

const num = (k: string, d: number) => (process.env[k] !== undefined ? Number(process.env[k]) : d);
const stats: EmbedStats = { calls: 0, aborted: 0, errors: 0, slow: 0, latencies: [] };
setEmbeddingProviderForTests(
  makeFakeProvider(
    {
      p50: num('LAT_P50', 80),
      p95: num('LAT_P95', 300),
      slowRate: num('LAT_SLOW', 0.02),
      errorRate: num('LAT_ERR', 0.005),
    },
    stats
  )
);
const dump = () => {
  const l = [...stats.latencies].sort((a, b) => a - b);
  const q = (p: number) => (l.length ? l[Math.min(l.length - 1, Math.floor(p * l.length))] : 0);
  if (process.env.STATS_FILE)
    writeFileSync(
      process.env.STATS_FILE,
      JSON.stringify({
        calls: stats.calls,
        aborted: stats.aborted,
        errors: stats.errors,
        slow: stats.slow,
        p50: q(0.5),
        p95: q(0.95),
        p99: q(0.99),
      })
    );
};
setInterval(dump, 5000).unref();
process.on('SIGTERM', () => {
  dump();
  process.exit(0);
});
void import('../../apps/api/src/index');
