// Shared bench helpers for the store-do spike (no deps; Node 20+ fetch).
export function pct(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Math.round(sorted[i] * 100) / 100;
}

export function summarise(samples, errors, statuses) {
  const s = [...samples].sort((a, b) => a - b);
  return {
    n: s.length,
    errors,
    statuses,
    p50_ms: pct(s, 50),
    p95_ms: pct(s, 95),
    p99_ms: pct(s, 99),
    max_ms: s.length ? Math.round(s[s.length - 1] * 100) / 100 : null,
  };
}

// Runs `total` calls at `concurrency`, discarding the first `warmup` successful samples.
export async function bench(fn, { total = 200, concurrency = 4, warmup = 10 } = {}) {
  const samples = [];
  const statuses = {};
  let errors = 0;
  let next = 0;
  async function worker() {
    while (next < total) {
      const i = next++;
      const t0 = performance.now();
      try {
        const res = await fn(i);
        // A fn may time just the call it cares about: return { status, ms }.
        const status = typeof res === 'object' ? res.status : res;
        const dt = typeof res === 'object' && res.ms != null ? res.ms : performance.now() - t0;
        statuses[status] = (statuses[status] || 0) + 1;
        if (status >= 200 && status < 300) samples.push([i, dt]);
        else errors++;
      } catch {
        errors++;
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  samples.sort((a, b) => a[0] - b[0]);
  const kept = samples.slice(warmup).map(x => x[1]);
  return summarise(kept, errors, statuses);
}

export function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : def;
}
