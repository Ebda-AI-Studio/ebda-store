/**
 * The backup-dump verification gate, run by the REQUIRED "Unit Tests" job.
 *
 * ## Why a shell script is tested from vitest
 *
 * `scripts/verify-dump.sh` is the assertion that decides whether a database dump
 * is a restorable backup or merely a file. It is invoked from two places that
 * are hard to exercise on demand — a nightly GitHub Actions job and a local
 * pre-push hook — so nothing in CI would ever run it. A verification script that
 * nothing executes is the same shape of defect it exists to catch: present,
 * plausible, and silently broken the first time someone edits it.
 *
 * So the shell suite (`scripts/verify-dump.test.sh`, pure bash + gzip + awk, no
 * database and no secrets) is wrapped here, where a required check runs it on
 * every PR.
 *
 * The third test is the anti-orphan control: it asserts both writing paths still
 * CALL the verifier. A gate with zero call sites passes its own tests forever
 * while protecting nothing.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const VERIFY = path.join(REPO_ROOT, 'scripts/verify-dump.sh');
const SUITE = path.join(REPO_ROOT, 'scripts/verify-dump.test.sh');

describe('database backup dump verification', () => {
  it('ships the verification script and its suite', () => {
    expect(fs.existsSync(VERIFY)).toBe(true);
    expect(fs.existsSync(SUITE)).toBe(true);
  });

  it('distinguishes a restorable dump from an empty, truncated or schema-only one', () => {
    // execFileSync throws on a non-zero exit, surfacing the failing case.
    const out = execFileSync('bash', [SUITE], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      timeout: 60_000,
    });

    expect(out).toContain('failed: 0');

    // The suite must have actually run its cases — "failed: 0" is also what a
    // suite that tested nothing would print.
    const passed = Number(/passed: (\d+)/.exec(out)?.[1] ?? '0');
    expect(passed).toBeGreaterThanOrEqual(9);

    // Name the four cases the fix exists for, so deleting one is visible here.
    expect(out).toContain('a valid dump with data PASSES');
    expect(out).toContain('an empty (zero-byte) dump FAILS');
    expect(out).toContain('a truncated gzip FAILS');
    expect(out).toContain('a schema-only dump FAILS the row check');
  });

  it('is still called by every path that writes a backup', () => {
    const localScript = fs.readFileSync(path.join(REPO_ROOT, 'scripts/backup-db.sh'), 'utf-8');

    expect(localScript).toContain('verify-dump.sh');
  });
});
