#!/usr/bin/env node
/**
 * Migration ordering gate.
 *
 * Prisma applies `packages/database/prisma/migrations/<14-digit timestamp>_<name>`
 * folders in lexical order and records each by folder name. Two ways a PR can
 * break that silently:
 *
 *   1. It ADDS a folder whose timestamp sorts BEFORE main's newest migration.
 *      Production has already applied main's newest, so `migrate deploy` runs
 *      the new one out of order — after migrations it was written to precede,
 *      and a fresh database (CI, a restore, a new branch) runs it in a
 *      different order from production. That is how schema drift between prod
 *      and a rebuilt DB is born.
 *   2. Two folders share the SAME 14-digit timestamp. Their relative order is
 *      then decided by the free-text name suffix, not by when they were
 *      written — typically two PRs branched on the same day both picked
 *      `20261001120000_*`.
 *
 * The rule (binding, see docs/RULINGS.md MIG-ORD-1): a new migration's
 * timestamp sorts strictly after main's newest, and no timestamp is shared.
 *
 * Grandfathered: timestamp collisions that are ALREADY applied in production
 * cannot be renamed (the folder name is the key in `_prisma_migrations`; a
 * rename reads as a brand-new migration). They are listed below by EXACT
 * folder set — a new folder that joins one of those timestamps still fails.
 *
 *   node scripts/check-migration-order.mjs                    # --base origin/main
 *   node scripts/check-migration-order.mjs --base <git-ref>
 *   node scripts/check-migration-order.mjs --fetch             # refresh origin/main first
 *     (shallow --depth=1 only when CI=true AND GITHUB_ACTIONS=true — see fetchArgs)
 *   node scripts/check-migration-order.mjs --fetch --base <40-hex sha>
 *     post-merge arm (issue 2355): on a push to main, CI passes the PRE-push tip
 *     (`github.event.before`), fetched by sha, so the just-merged folders are the
 *     "added" set and one that sorts at/before the previous newest fails ON MAIN.
 *     The PR-time arm alone cannot see two PRs that each passed against the same
 *     old main and then both merged.
 *   node scripts/check-migration-order.mjs --migrations-dir <path>
 *
 * Exit 0 = clean, 1 = a violation, 2 = could not read the base (fail closed).
 */

import { readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_MIGRATIONS_DIR = 'packages/database/prisma/migrations';

/**
 * Timestamp collisions already applied in production before this gate existed.
 * Keyed by timestamp; the value is the exact folder set allowed to share it.
 */
export const GRANDFATHERED_DUPLICATES = {
  20260615000000: [
    '20260615000000_add_bank_reconciliation',
    '20260615000000_add_journal_line_fx_fields',
    '20260615000000_add_order_sms_opt_in',
    '20260615000000_barcode_scanning',
    '20260615000000_multi_warehouse',
  ],
  20260925160000: [
    '20260925160000_bundle_items_cart_bundles_rls',
    '20260925160000_store_usage_snapshot_bigint',
  ],
};

const NAME_RE = /^(\d{14})_[a-z0-9_]+$/;

/**
 * Pure check. `baseNames` = migration folders on main, `headNames` = folders in
 * the PR's tree. Returns a list of human-readable violations (empty = clean).
 */
export function checkMigrationOrder({
  baseNames,
  headNames,
  grandfathered = GRANDFATHERED_DUPLICATES,
}) {
  const violations = [];
  const base = new Set(baseNames);
  const added = headNames.filter(n => !base.has(n)).sort();

  for (const name of added) {
    if (!NAME_RE.test(name)) {
      violations.push(
        `${name}: migration folder names must be <14-digit UTC timestamp>_<lower_snake_name>`
      );
    }
  }

  const baseStamps = baseNames
    .map(n => n.match(NAME_RE)?.[1])
    .filter(Boolean)
    .sort();
  const newestBase = baseStamps[baseStamps.length - 1];
  if (newestBase) {
    const newestBaseName = baseNames
      .filter(n => n.startsWith(`${newestBase}_`))
      .sort()
      .pop();
    for (const name of added) {
      const stamp = name.match(NAME_RE)?.[1];
      if (stamp && stamp <= newestBase) {
        violations.push(
          `${name}: timestamp ${stamp} does not sort after main's newest migration ` +
            `${newestBaseName} — production has already applied that one, so this would run ` +
            `out of order. Rename the folder to a timestamp later than ${newestBase}.`
        );
      }
    }
  }

  const byStamp = new Map();
  for (const name of headNames) {
    const stamp = name.match(NAME_RE)?.[1];
    if (!stamp) continue;
    if (!byStamp.has(stamp)) byStamp.set(stamp, []);
    byStamp.get(stamp).push(name);
  }
  for (const [stamp, names] of [...byStamp].sort()) {
    if (names.length < 2) continue;
    const allowed = grandfathered[stamp];
    const same =
      allowed &&
      allowed.length === names.length &&
      [...allowed].sort().every((n, i) => n === [...names].sort()[i]);
    if (!same) {
      violations.push(
        `timestamp ${stamp} is shared by ${names.length} migration folders ` +
          `(${[...names].sort().join(', ')}) — their order would be decided by the name ` +
          `suffix. Give the new one its own, later timestamp.`
      );
    }
  }

  return violations;
}

/**
 * `git fetch` arguments for refreshing origin/main (`--fetch`).
 *
 * `--depth` ONLY inside GitHub Actions. Every worktree on a developer or agent
 * machine shares ONE .git, and a depth-1 fetch there writes `.git/shallow` —
 * even when the ref is already current, so it leaves no reflog entry — which
 * turns every worktree's history into one commit and breaks every merge with
 * "refusing to merge unrelated histories". That happened twice on 2026-09-30,
 * both times with the grafted commit equal to origin/main's tip at the moment,
 * i.e. the CI step's own `git fetch --depth=1 origin main` run outside CI.
 */
export function fetchArgs(env = process.env, baseRef = 'origin/main') {
  const inActions = env.CI === 'true' && env.GITHUB_ACTIONS === 'true';
  return [
    'fetch',
    '--no-tags',
    ...(inActions ? ['--depth=1'] : []),
    'origin',
    // A commit sha (the post-merge arm's pre-push tip) is fetched by id — no
    // refspec, so no local ref is written or moved. Anything else refreshes main.
    SHA_RE.test(baseRef) ? baseRef : '+refs/heads/main:refs/remotes/origin/main',
  ];
}

const SHA_RE = /^[0-9a-f]{40}$/;
const ZERO_SHA = /^0{40}$/;

function listHead(dir) {
  return readdirSync(dir).filter(n => statSync(path.join(dir, n)).isDirectory());
}

function listBase(ref, dir) {
  const res = spawnSync('git', ['ls-tree', `${ref}:${dir}`], { encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(`git ls-tree ${ref}:${dir} failed: ${(res.stderr || '').trim()}`);
  }
  return res.stdout
    .split('\n')
    .filter(Boolean)
    .map(line => line.split('\t'))
    .filter(([meta]) => meta.split(' ')[1] === 'tree')
    .map(([, name]) => name);
}

function main(argv) {
  const arg = k => argv.find(a => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  const idx = k => argv.indexOf(`--${k}`);
  const val = k => arg(k) ?? (idx(k) >= 0 ? argv[idx(k) + 1] : undefined);
  const baseRef = val('base') ?? 'origin/main';
  const dir = val('migrations-dir') ?? DEFAULT_MIGRATIONS_DIR;

  if (ZERO_SHA.test(baseRef)) {
    // A push event whose `before` is all zeros has no previous tip to compare
    // against — fail CLOSED rather than compare nothing and print "clean".
    console.error(`migration-order: base ${baseRef} is the null sha — nothing to compare against`);
    return 2;
  }
  if (argv.includes('--fetch')) {
    const f = spawnSync('git', fetchArgs(process.env, baseRef), { encoding: 'utf8' });
    if (f.status !== 0) {
      console.error(`migration-order: cannot fetch ${baseRef} — ${(f.stderr || '').trim()}`);
      return 2;
    }
  }

  let baseNames;
  try {
    baseNames = listBase(baseRef, dir);
  } catch (err) {
    // Fail CLOSED: a gate that cannot see main must not report "clean".
    console.error(`migration-order: cannot read ${dir} at ${baseRef} — ${err.message}`);
    return 2;
  }
  if (baseNames.length === 0) {
    console.error(`migration-order: ${baseRef} has no migrations under ${dir} — refusing to pass`);
    return 2;
  }
  const headNames = listHead(dir);
  const violations = checkMigrationOrder({ baseNames, headNames });
  const added = headNames.filter(n => !baseNames.includes(n));
  if (violations.length) {
    for (const v of violations) console.error(`::error::migration-order: ${v}`);
    return 1;
  }
  console.log(
    `migration-order: clean — ${headNames.length} migration folder(s), ${added.length} new vs ${baseRef}` +
      (added.length ? ` (${added.join(', ')})` : '')
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exit(main(process.argv.slice(2)));
}

export { main };
