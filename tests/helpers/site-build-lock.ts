import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Cross-process lock for tests that BUILD apps/help or apps/docs and then read their `out/` (and docs' `.generated/`).
 * The pre-push gate runs unit test files in parallel worker processes (`--maxWorkers=50%`); every build starts with
 * `resetOut`, which wipes `out/`, so a second file's build deleted the first file's pages mid-read (ENOENT / "expected
 * false to be true" on a page that is not missing). Hold the lock from before the build until the file's last read.
 * mkdir is atomic; a lock whose owner pid is dead is broken by rename (only one breaker wins).
 */
const LOCK = path.join(tmpdir(), 'ebda-site-build.lock');
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

export async function acquireSiteBuildLock(maxWaitMs = 600_000): Promise<() => void> {
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    try {
      mkdirSync(LOCK);
      writeFileSync(path.join(LOCK, 'pid'), String(process.pid));
      return () => rmSync(LOCK, { recursive: true, force: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    let owner = NaN;
    try {
      owner = Number(readFileSync(path.join(LOCK, 'pid'), 'utf8'));
    } catch {
      /* owner is between mkdir and writing its pid: wait a tick */
    }
    if (Number.isFinite(owner) && owner > 0 && !alive(owner)) {
      try {
        renameSync(LOCK, `${LOCK}.dead.${process.pid}`);
        rmSync(`${LOCK}.dead.${process.pid}`, { recursive: true, force: true });
      } catch {
        /* another waiter broke it first */
      }
      continue;
    }
    if (Date.now() > deadline)
      throw new Error(`site-build lock held by pid ${owner} for > ${maxWaitMs}ms`);
    await new Promise(r => setTimeout(r, 250));
  }
}
