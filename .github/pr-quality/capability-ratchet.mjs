#!/usr/bin/env node
// Capability baselines may only shrink (os/standard/ai-native-self-service.md, docs/standard/capability-registry.md).
//   node capability-ratchet.mjs --base <base-checkout> --pr <pr-checkout>
// For every capabilities/baselines/*.json in the PR checkout, fails (exit 1) listing each id the PR file has and the base file lacks.
// A base with no baselines at all (the adoption PR) is allowed; once it has any, a NEW baseline file must be empty. A file that is not { "ids": [...] } is an error. Runs from the base checkout, so a PR cannot edit the judge (Ruling PRQ-3).
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readJsonRegular, mergeBaseRef, sourceOfId } from './slop-guard.mjs';

const DIR = 'capabilities/baselines';
/** The ids of a baseline file; a file that is not `{ "ids": [...] }` is invalid, never "empty". */
const idsOf = (p) => {
  const j = readJsonRegular(p);
  if (!j || !Array.isArray(j.ids) || j.ids.some((x) => typeof x !== 'string')) throw new Error(`${p}: not a baseline (expected { "ids": ["rule|key", ...] })`);
  return j.ids;
};

/** `mb` (optional, from mergeBaseRef): an id absent from the base TIP is still allowed when the PR left it unchanged since the merge-base
 *  (it is in the merge-base file and names a real file of the merge-base tree that is not in `mb.touched`; ids with no real path are judged against the tip). Everything the PR touches is judged against the tip. */
export function growth(base, pr, mb = null) {
  const out = [];
  const dir = join(pr, DIR);
  if (!existsSync(dir) || lstatSync(dir).isSymbolicLink()) return out;
  const baseDir = join(base, DIR);
  const adopted = existsSync(baseDir) && readdirSync(baseDir).some((n) => n.endsWith('.json'));
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    const prIds = idsOf(join(dir, name)); // validated even when the base has no such file
    const bp = join(baseDir, name);
    const mbp = mb && join(mb.dir, DIR, name);
    const M = new Set(mbp && existsSync(mbp) ? idsOf(mbp) : []);
    const unchanged = (id) => { const src = mb && sourceOfId(id, mb); return M.has(id) && !!src && !mb.touched.has(src); };
    if (!existsSync(bp)) {
      // the first adoption PR may seed any baseline; after that a new baseline file must start empty (it can only shrink from nothing)
      if (adopted) for (const id of prIds) if (!unchanged(id)) out.push(`${name} (new file): ${id}`);
      continue;
    }
    const B = new Set(idsOf(bp));
    for (const id of prIds) if (!B.has(id) && !unchanged(id)) out.push(`${name}: ${id}`);
  }
  return out;
}

function main() {
  const a = process.argv.slice(2);
  const arg = (k) => (a.includes(k) ? a[a.indexOf(k) + 1] : undefined);
  const base = arg('--base');
  const pr = arg('--pr');
  if (!base || !pr) { console.error('usage: capability-ratchet.mjs --base <base-checkout> --pr <pr-checkout>'); process.exit(2); }
  let grew;
  try {
    grew = growth(base, pr, mergeBaseRef(arg('--merge-base-root')));
  } catch (e) {
    console.error(`capability-ratchet: ${e.message}`);
    process.exit(1);
  }
  for (const g of grew) console.error(`capability-ratchet: the PR baseline holds an id the base branch's does not (baselines only shrink): ${g}`);
  if (grew.length) process.exit(1);
  console.log('capability-ratchet: ok (no baseline grew)');
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
