import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Ruling AI-REVIEW-HANG-1: the reviewer call is bounded and retried once inside the step, so a network hang cannot
// eat the whole job timeout (#740, 2026-11-13: two 20-minute cancellations on a 35 KB diff).
const wf = fs.readFileSync(
  path.resolve(__dirname, '../../.github/workflows/ai-review.yml'),
  'utf8'
);
const step = wf.slice(
  wf.indexOf('- name: Review the diff'),
  wf.indexOf('- name: Post findings and gate')
);
const jobTimeout = Number(/review:[\s\S]*?timeout-minutes:\s*(\d+)/.exec(wf)?.[1]);

describe('AI review call is bounded and retried (Ruling AI-REVIEW-HANG-1)', () => {
  it('wraps claude -p in timeout', () => {
    expect(step).toMatch(/timeout (\d+) claude -p/);
  });
  it('retries exactly once and fails closed after', () => {
    expect(step).toMatch(/for attempt in 1 2; do/);
    expect(step.trimEnd()).toMatch(/exit 1$/);
  });
  it('two bounded attempts fit inside the job timeout', () => {
    const per = Number(/timeout (\d+) claude -p/.exec(step)?.[1]);
    expect(2 * per).toBeLessThan(jobTimeout * 60 - 120);
  });
});
