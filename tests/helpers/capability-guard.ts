/**
 * Shared plumbing for the capability guard tests: load the registry and a shrink-only baseline,
 * run `applyBaseline`, report tolerated debt as ::warning:: lines, fail on a new violation or a stale baseline id.
 * A guard that finds nothing is only believable if it can fail: every guard test carries a mutation `it`.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type {
  Capability,
  GuardConfig,
  Violation,
} from '../../packages/shared/src/foundation/capability';
import { checkRegistry } from '../../packages/shared/src/foundation/capability-registry';
import {
  applyBaseline,
  guardOutcome,
  violationId,
} from '../../packages/shared/src/foundation/ratchet';
import { REPO_ROOT, readConfig } from './capability-facts';

export type BaselineName = 'registry' | 'coverage' | 'superadmin' | 'bypass' | 'help';

export const loadRegistryFiles = (): { name: string; json: unknown }[] => {
  const dir = join(REPO_ROOT, 'capabilities');
  return readdirSync(dir)
    .filter(f => f.endsWith('.capability.json'))
    .sort()
    .map(name => ({ name, json: JSON.parse(readFileSync(join(dir, name), 'utf8')) as unknown }));
};

export const loadRegistry = (
  cfg: GuardConfig = readConfig()
): { entries: Capability[]; violations: Violation[] } => checkRegistry(loadRegistryFiles(), cfg);

export const loadBaseline = (name: BaselineName): string[] => {
  const p = join(REPO_ROOT, 'capabilities/baselines', `${name}.json`);
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as { ids: string[] }).ids : [];
};

/** Apply a baseline; print tolerated debt as annotations (first 10 + a count); return the failure lines. */
export function judge(
  name: BaselineName,
  violations: Violation[]
): { failures: string[]; tolerated: number; stale: string[] } {
  const r = applyBaseline(violations, loadBaseline(name));
  const { failures, warnings } = guardOutcome(r);
  for (const w of warnings.slice(0, 10)) console.warn(w);
  if (warnings.length)
    console.warn(
      `::warning::${name} baseline: ${warnings.length} tolerated violation(s), shrink-only (${warnings.length > 10 ? 'first 10 shown' : 'all shown'})`
    );
  return { failures, tolerated: r.tolerated.length, stale: r.stale };
}

export const idsOf = (vs: Violation[]): string[] => vs.map(violationId);

/** Source files for the Smart Layer bypass scan: ts/tsx/js/mjs under apps and packages, plus every wrangler config. */
export function bypassFiles(): { path: string; src: string }[] {
  const out: { path: string; src: string }[] = [];
  const skipDir = new Set([
    'node_modules',
    'dist',
    '.next',
    '.turbo',
    '.open-next',
    'coverage',
    '.wrangler',
    '.claude',
  ]);
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (!skipDir.has(e.name)) walk(p);
      } else if (/\.(?:[cm]?[jt]sx?)$/.test(e.name) || /^wrangler\.(?:jsonc?|toml)$/.test(e.name)) {
        if (statSync(p).size < 2_000_000)
          out.push({
            path: relative(REPO_ROOT, p).split('\\').join('/'),
            src: readFileSync(p, 'utf8'),
          });
      }
    }
  };
  for (const root of ['apps', 'packages'])
    if (existsSync(join(REPO_ROOT, root))) walk(join(REPO_ROOT, root));
  return out;
}
