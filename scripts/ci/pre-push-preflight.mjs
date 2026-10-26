#!/usr/bin/env node
/**
 * pre-push-preflight.mjs - the first, cheapest part of the pre-push gate (Ahmad 2026-10-26: "these types of errors
 * waste time"). It closes three classes of CI waste before a single test runs:
 *
 *   merge      the branch does not merge cleanly into a FRESH origin/main (git merge-tree --write-tree). A conflicting PR
 *              can never go green; it used to sit in the merge gate for hours.
 *   migration  scripts/check-migration-order.mjs against the fresh origin/main, AND every NEW migration's 14-digit number
 *              must be in the controller's registry (~/.claude/handoff/2f8ff692-merge-train.md, "Migration number
 *              registry"). An unreadable registry warns and continues; the repo check still runs.
 *   cron       every wrangler cron uses weekday NAMES (SUN..SAT) in the day-of-week field. Cloudflare numbers weekdays
 *              1-7 with 1=Sunday, not the 0-6 of standard cron, so a numeric weekday silently fires on the wrong day.
 *
 * Usage: node scripts/ci/pre-push-preflight.mjs [--registry <file>] [--base <ref>]   exit 0 ok, 1 refuse.
 * Pure helpers are exported for tests.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MIG_DIR = 'packages/database/prisma/migrations';
export const DEFAULT_REGISTRY = path.join(homedir(), '.claude/handoff/2f8ff692-merge-train.md');
const DOW_NAME = /^(SUN|MON|TUE|WED|THU|FRI|SAT)(-(SUN|MON|TUE|WED|THU|FRI|SAT))?$/i;

/** Problems with one cron string's day-of-week field (empty list = fine). */
export function cronProblems(cron) {
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) return [`"${cron}": expected 5 fields, got ${f.length}`];
  const dow = f[4];
  if (dow === '*' || dow === '?') return [];
  const bad = dow.split(',').filter(p => !DOW_NAME.test(p.replace(/\/\d+$/, '')));
  return bad.length
    ? [
        `"${cron}": day-of-week "${dow}" must be names (SUN..SAT) - Cloudflare numbers weekdays 1-7 with 1=Sunday, not 0-6`,
      ]
    : [];
}

/** Every string in a wrangler config's triggers.crons list(s). Comments are stripped first. */
export function cronsIn(text) {
  const noComments = text.replace(/\/\/[^\n]*/g, '');
  const out = [];
  for (const m of noComments.matchAll(/"crons"\s*:\s*\[([^\]]*)\]/g))
    for (const s of m[1].matchAll(/"([^"]*)"/g)) out.push(s[1]);
  return out;
}

/** Registry check: which of the new migration folders have a number the controller did not assign? */
export function unregisteredMigrations(newFolders, registryText) {
  const nums = [...registryText.matchAll(/(?<!\d)(\d{14})(?!\d)/g)].map(m => m[1]);
  const ranges = [...registryText.matchAll(/(?<!\d)(\d{14})\s*\.\.\s*(\d{14})(?!\d)/g)].map(m => [
    m[1],
    m[2],
  ]);
  return newFolders.filter(f => {
    const n = f.slice(0, 14);
    return !(nums.includes(n) || ranges.some(([a, b]) => n >= a && n <= b));
  });
}

const git = (cwd, env, ...a) =>
  execFileSync('git', a, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** Run all three checks in repo `root`; returns { refusals: string[], warnings: string[] }. */
export function preflight({
  root,
  registry = DEFAULT_REGISTRY,
  base = 'origin/main',
  fetch = true,
  env = process.env,
}) {
  const refusals = [];
  const warnings = [];

  if (fetch) {
    try {
      git(root, env, 'fetch', '-q', 'origin', 'main');
    } catch (e) {
      warnings.push(
        `could not fetch origin/main (${String(e.message).split('\n')[0]}); checking against the local ${base}`
      );
    }
  }

  // (a) merges cleanly into the fresh main?
  const mt = spawnSync('git', ['merge-tree', '--write-tree', base, 'HEAD'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });
  if (mt.status === 1) {
    const files = [
      ...(mt.stdout || '').matchAll(/CONFLICT \([^)]*\): (?:Merge conflict in )?([^\n]+)/g),
    ].map(m => m[1]);
    refusals.push(
      `this branch does not merge cleanly into ${base}${files.length ? ` (conflicts: ${files.join(', ')})` : ''}. Rebase or merge ${base} first, resolve, then push - a conflicting PR can never go green.`
    );
  } else if (mt.status !== 0) {
    warnings.push(
      `git merge-tree could not run (exit ${mt.status}): ${(mt.stderr || '').split('\n')[0]}`
    );
  }

  // (b) migrations: repo order check against the fresh main + controller registry
  const added = (() => {
    try {
      return git(
        root,
        env,
        'diff',
        '--name-only',
        '--diff-filter=A',
        `${base}...HEAD`,
        '--',
        MIG_DIR
      )
        .split('\n')
        .map(p => p.split('/')[4])
        .filter(Boolean);
    } catch {
      return [];
    }
  })();
  const newFolders = [...new Set(added)];
  const order = spawnSync('node', ['scripts/check-migration-order.mjs', '--base', base], {
    cwd: root,
    env,
    encoding: 'utf8',
  });
  if (order.status !== 0)
    refusals.push(
      `migration order: ${(order.stdout + order.stderr).trim().split('\n').slice(-6).join(' | ')}`
    );
  if (newFolders.length) {
    if (!existsSync(registry))
      warnings.push(`migration registry unreadable (${registry}); only the repo check ran`);
    else {
      let text = '';
      try {
        text = readFileSync(registry, 'utf8');
      } catch {
        warnings.push(`migration registry unreadable (${registry}); only the repo check ran`);
      }
      if (text) {
        const bad = unregisteredMigrations(newFolders, text);
        if (bad.length)
          refusals.push(
            `new migration number(s) not in the controller's "Migration number registry": ${bad.join(', ')}. Ask the controller for a number first.`
          );
      }
    }
  }

  // (c) wrangler crons: weekday names only. DIFF-SCOPED: a cron ADDED or CHANGED in this push that breaks the rule is a
  // refusal; a violation already on the base is only a warning (so one in-flight fix elsewhere cannot block every push).
  const appsDir = path.join(root, 'apps');
  if (existsSync(appsDir)) {
    for (const app of readdirSync(appsDir)) {
      for (const name of ['wrangler.jsonc', 'wrangler.json']) {
        const rel = `apps/${app}/${name}`;
        const f = path.join(root, rel);
        if (!existsSync(f)) continue;
        let baseCrons = new Set();
        try {
          baseCrons = new Set(cronsIn(git(root, env, 'show', `${base}:${rel}`)));
        } catch {
          /* file is new in this push: every cron in it is "added" */
        }
        for (const c of cronsIn(readFileSync(f, 'utf8'))) {
          for (const p of cronProblems(c)) {
            if (baseCrons.has(c))
              warnings.push(`${rel}: ${p} (already on ${base}, not introduced by this push)`);
            else refusals.push(`${rel}: ${p}`);
          }
        }
      }
    }
  }
  return { refusals, warnings };
}

function main(argv) {
  const val = k => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : undefined);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const { refusals, warnings } = preflight({
    root,
    registry: val('registry') ?? DEFAULT_REGISTRY,
    base: val('base') ?? 'origin/main',
  });
  for (const w of warnings) console.warn(`! pre-push preflight: ${w}`);
  if (refusals.length) {
    for (const r of refusals) console.error(`X pre-push preflight REFUSED: ${r}`);
    return 1;
  }
  console.log(
    '-> pre-push preflight: merges cleanly, migrations ordered + registered, crons use weekday names'
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  process.exit(main(process.argv.slice(2)));
