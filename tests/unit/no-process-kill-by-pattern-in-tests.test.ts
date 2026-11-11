/**
 * Guard (2026-11-11): a test must never `pkill`/`killall` (kill by name or pattern). Other agents' vitest runs on the same
 * Mac are legitimate and match the same patterns ("kill only PIDs you started"). Track the pid you spawned (a detached
 * child's process group via `process.kill(-pid)`) and kill that.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '../..');
const KILL_BY_PATTERN = /\b(?:pkill|killall)\b|\bkill\s+\$\(\s*(?:pgrep|ps)\b/;

export const killsByPattern = (src: string): boolean => KILL_BY_PATTERN.test(src);

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (['node_modules', '.git', 'dist', '.next', '.open-next', '__fixtures__'].includes(e))
      continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(test|spec)\.(ts|tsx|mts|mjs|js)$/.test(e)) out.push(p);
  }
  return out;
}

describe('tests never kill processes by name or pattern', () => {
  it('self-test: flags pkill/killall, spares process.kill(pid)', () => {
    expect(killsByPattern(`spawnSync('pkill', ['-f', 'sleep 60'])`)).toBe(true);
    expect(killsByPattern(`execSync('killall node')`)).toBe(true);
    expect(killsByPattern('execSync(`kill $(pgrep -f vitest)`)')).toBe(true);
    expect(killsByPattern(`process.kill(-child.pid!, 'SIGKILL')`)).toBe(false);
  });

  it('scans real test files (not vacuous)', () => {
    expect(walk(ROOT).length).toBeGreaterThan(200);
  });

  it('no test uses pkill / killall / kill $(pgrep)', () => {
    const self = 'tests/unit/no-process-kill-by-pattern-in-tests.test.ts';
    const offenders = walk(ROOT)
      .map(f => relative(ROOT, f))
      .filter(rel => rel !== self && killsByPattern(readFileSync(join(ROOT, rel), 'utf8')));
    expect(offenders, 'kill only the pid/process group this test spawned').toEqual([]);
  });
});
