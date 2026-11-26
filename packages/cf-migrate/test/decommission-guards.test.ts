import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The decommission script's destructive commands are exercised ONLY as refusals here: no Neon, R2 or
// Cloudflare call is made (every case fails before reaching a network or a CLI).
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const script = path.join(root, 'scripts/cf/decommission-neon.mjs');
const run = (args: string[], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', ...env },
  });

function manifest(over: Record<string, unknown> = {}) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'decom-test-')), 'm.json');
  fs.writeFileSync(
    f,
    JSON.stringify({
      project: 'lucky-truth-54548746',
      at: new Date().toISOString(),
      verified: true,
      drillOk: true,
      ...over,
    })
  );
  return f;
}

describe('decommission-neon guards', () => {
  it('knows only the six commands', () => {
    const r = run(['bogus']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(
      /preflight\|final-dump\|restore-drill\|residue\|remove-bindings\|delete-neon/
    );
  });

  it('preflight needs the flip time', () => {
    expect(run(['preflight']).stderr).toMatch(/--flipped-at/);
  });

  it('final-dump needs the R2 account and refuses a pooler URL before touching anything', () => {
    expect(run(['final-dump']).stderr).toMatch(/--r2-account/);
    const r = run(['final-dump', '--r2-account', 'x'], {
      DECOMMISSION_PG_URL: 'postgres://u@ep-x-pooler.eu.neon.tech/db',
    });
    expect(r.stderr).toMatch(/pooler/);
  });

  it('final-dump reuses the ops backup scheme: it needs scripts/ops/verify-db-dump.sh and an age public key', () => {
    const direct = { DECOMMISSION_PG_URL: 'postgres://u@ep-x.eu.neon.tech/db' };
    const r = run(['final-dump', '--r2-account', 'x'], direct);
    if (!fs.existsSync(path.join(root, 'scripts/ops/verify-db-dump.sh'))) {
      expect(r.stderr).toMatch(/verify-db-dump\.sh is missing/);
    } else {
      const bad = run(['final-dump', '--r2-account', 'x'], {
        ...direct,
        EBDA_BACKUP_AGE_PUBLIC_KEY: 'not-a-key',
      });
      expect(bad.stderr).toMatch(
        /not an age public key|pg_dump >= 17|Command failed: pg_dump --version/
      );
    }
  });

  it('the old AES scheme and bucket are gone', () => {
    const src = fs.readFileSync(script, 'utf8');
    expect(src).not.toMatch(/aes-256|databasebackup|DB_BACKUP_PASSPHRASE/);
    expect(src).toMatch(/ebda-db-backups/);
    expect(src).toMatch(/ebda-db-backup-age-key/);
  });

  it('restore-drill refuses a non-scratch database, Neon, or no scratch url', () => {
    const m = manifest();
    expect(run(['restore-drill', '--manifest', m]).stderr).toMatch(/--scratch-pg-url/);
    expect(
      run(['restore-drill', '--manifest', m, '--scratch-pg-url', 'postgres://u@localhost/ebda'])
        .stderr
    ).toMatch(/refusing to restore/);
    expect(
      run([
        'restore-drill',
        '--manifest',
        m,
        '--scratch-pg-url',
        'postgres://u@x.neon.tech/ebda_scratch',
      ]).stderr
    ).toMatch(/refusing to restore/);
  });

  it('remove-bindings and delete-neon need a PASSED restore drill', () => {
    for (const cmd of ['remove-bindings', 'delete-neon']) {
      expect(run([cmd, '--manifest', manifest({ drillOk: false })]).stderr).toMatch(
        /restore drill has not passed/
      );
    }
  });

  it('remove-bindings and delete-neon refuse without a manifest, with an unverified one, or for another project', () => {
    for (const cmd of ['remove-bindings', 'delete-neon']) {
      expect(run([cmd]).stderr).toMatch(/--manifest/);
      expect(run([cmd, '--manifest', manifest({ verified: false })]).stderr).toMatch(
        /not a verified final dump/
      );
      expect(run([cmd, '--manifest', manifest({ project: 'other' })]).stderr).toMatch(
        /not a verified final dump/
      );
    }
  });

  // depends on the repo state, so it holds both before and after the code cleanup lands
  const residueClean = () => /^0 file\(s\)/.test(run(['residue']).stdout);

  it('remove-bindings refuses while code still names Postgres (it would take the API down)', () => {
    if (residueClean()) return;
    const r = run(['remove-bindings', '--manifest', manifest(), '--yes']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/code cleanup is not finished/);
  });

  it("delete-neon needs Ahmad's approval reference", () => {
    expect(run(['delete-neon', '--manifest', manifest()]).stderr).toMatch(/--ahmad-yes/);
  });

  it('residue --strict exits 1 exactly while Postgres paths remain', () => {
    const r = run(['residue', '--strict']);
    expect(r.status).toBe(residueClean() ? 0 : 1);
    expect(r.stdout).toMatch(/file\(s\) still name Postgres/);
  });

  it('the residue count never grows past the committed ratchet (shrinking-only)', () => {
    const { max } = JSON.parse(
      fs.readFileSync(path.join(root, 'scripts/cf/residue-ratchet.json'), 'utf8')
    );
    const n = Number(run(['residue']).stdout.match(/^(\d+) file\(s\)/)?.[1]);
    expect(Number.isInteger(n)).toBe(true);
    expect(n).toBeLessThanOrEqual(max);
  });
});
