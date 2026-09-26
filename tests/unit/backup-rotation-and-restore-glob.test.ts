/**
 * #1846 + #1847 — the backup rotation window claim and the restore runbooks'
 * "find the dump" step.
 *
 * #1846: `scripts/backup-db.sh` (pre-push) used to share the SAME
 * `_backups/<project>/` directory and unscoped 30-slot prune as the nightly
 * `backup-all-neon.sh`, so the documented "30 rotations = 30-day window"
 * claim shrank on any day with heavy push volume. Fixed by giving pre-push
 * its own `pre-push/` subdirectory with its own (smaller) cap.
 *
 * #1847: both restore runbooks did an UNGLOBBED `ls -lt` over the backup
 * directory, which also lists `.sql.gz.SUSPECT` files (a dump that failed
 * `verify-dump.sh`, parked by `backup-db.sh`) — a fresh one sorts to the top
 * as if it were the newest good backup. Fixed by globbing to `*.sql.gz` and
 * verifying the chosen file before trusting it.
 *
 * Source-text assertions on a shell script + docs — same tool the sibling
 * `db-backup-verify-dump.test.ts` already uses for this same script, for the
 * same reason: actually running `backup-db.sh` needs a live Neon connection,
 * which this suite does not have.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');

describe('#1846 — pre-push dumps get their own rotation, separate from the nightly 30-day window', () => {
  const src = read('scripts/backup-db.sh');

  it('writes into a pre-push/ subdirectory, not the bare project backup dir', () => {
    expect(src).toMatch(
      /BACKUP_DIR="\$\{HOME\}\/Desktop\/projects\/_backups\/\$\{PROJECT_NAME\}\/pre-push"/
    );
  });

  it('prunes with its OWN cap, not the hardcoded 31 the nightly script effectively shared', () => {
    expect(src).toMatch(/PRE_PUSH_KEEP=\d+/);
    // The actual prune invocation — not the docstring above it, which
    // deliberately still mentions the old `tail -n +31` shape as the "what
    // this used to look like" explanation.
    const pruneLine = src.split('\n').find(l => l.includes('| xargs -r rm -f'));
    expect(pruneLine, 'prune line moved or was removed — re-point this test').toBeDefined();
    expect(pruneLine).not.toMatch(/\+31\b/);
    expect(pruneLine).toMatch(/tail -n \+\$\(\(PRE_PUSH_KEEP \+ 1\)\)/);
  });
});

describe('#1847 — restore runbooks glob to *.sql.gz and verify before trusting', () => {
  it('DB-BACKUP-RESTORE.md globs the local-dump listing and verifies the chosen file', () => {
    const doc = read('docs/DB-BACKUP-RESTORE.md');
    expect(doc).toMatch(
      /ls -lt ~\/Desktop\/projects\/_backups\/force-website-builder\/\*\.sql\.gz/
    );
    expect(doc).toMatch(/bash scripts\/verify-dump\.sh "\$DUMP"/);
  });

  it('ROLLBACK.md globs the "find the right backup" listing and verifies the chosen file', () => {
    const doc = read('docs/ROLLBACK.md');
    expect(doc).toMatch(
      /ls -lt ~\/Desktop\/projects\/_backups\/force-website-builder\/\*\.sql\.gz/
    );
    expect(doc).toMatch(/bash scripts\/verify-dump\.sh <chosen>\.sql\.gz/);
  });
});
