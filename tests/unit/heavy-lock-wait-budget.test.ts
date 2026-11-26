import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Ruling HOST-RUNNERS-4: GitHub counts the time a job waits for the heavy host lock against the JOB timeout.
// A shard that queued 1771 s behind another heavy job ran all 7948 tests green and was cancelled 0.3 s later (#747,
// 2026-11-13). Every job that acquires the lock must therefore budget the lock's own maximum wait on top of its run time.
const ROOT = path.resolve(__dirname, '../..');
const WORKFLOWS = path.join(ROOT, '.github/workflows');
const lockScript = fs.readFileSync(path.join(ROOT, 'scripts/ci/heavy-lock.sh'), 'utf8');
const maxWaitS = Number(/HEAVY_LOCK_MAX_WAIT_S:-(\d+)/.exec(lockScript)?.[1]);

function heavyJobs() {
  const out: { job: string; timeout: number | null }[] = [];
  for (const file of fs.readdirSync(WORKFLOWS).filter(f => f.endsWith('.yml'))) {
    const lines = fs.readFileSync(path.join(WORKFLOWS, file), 'utf8').split('\n');
    const starts = lines.flatMap((l, i) => (/^ {2}[a-z0-9_-]+:\s*$/.test(l) ? [i] : []));
    starts.forEach((a, k) => {
      const block = lines.slice(a, starts[k + 1] ?? lines.length);
      if (!block.some(l => l.includes('heavy-lock.sh acquire'))) return;
      // The timeout is a number, or (CI-FAILFAST-1) an expression `... && <hosted> || <self-hosted>`: the self-hosted
      // value (the last number) is the one that must cover the lock wait; the hosted value skips the no-op lock.
      const t = block.map(l => /^ {4}timeout-minutes:\s*(.+?)(?:\s+#.*)?$/.exec(l)).find(Boolean);
      const nums = t ? t[1].match(/\d+/g) : null;
      out.push({
        job: `${file}:${lines[a].trim().replace(':', '')}`,
        timeout: nums ? Number(nums[nums.length - 1]) : null,
      });
    });
  }
  return out;
}

describe('heavy-lock jobs budget the lock wait (Ruling HOST-RUNNERS-4)', () => {
  it('reads the lock max wait from heavy-lock.sh', () => {
    expect(maxWaitS).toBeGreaterThan(0);
  });
  it('finds the heavy jobs', () => {
    expect(heavyJobs().length).toBeGreaterThanOrEqual(5);
  });
  it('every heavy-lock job timeout exceeds the lock max wait plus a 20-minute run floor', () => {
    const short = heavyJobs().filter(j => j.timeout === null || j.timeout < maxWaitS / 60 + 20);
    expect(short).toEqual([]);
  });
});
