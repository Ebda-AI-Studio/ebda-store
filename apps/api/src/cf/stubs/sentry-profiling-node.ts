// Sentry CPU profiling is a native Node addon; there is no equivalent on Workers.
export function nodeProfilingIntegration(): { name: string } {
  return { name: 'NoopProfiling' };
}
