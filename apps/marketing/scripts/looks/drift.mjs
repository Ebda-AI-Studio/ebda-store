// Drift check (Ruling MKT-PHONES-1): re-snapshots the live demo stores into a temp dir and compares each
// template's visible text and class set, look by look, with the committed fragment. Exits 1 with the template
// and look that drifted. Needs network + Chrome; the weekly workflow runs it (.github/workflows/looks-drift.yml).
//   node scripts/looks/drift.mjs [qamar,souq,...]
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { diffNormalised, normalise } from './snapshot-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COMMITTED = path.join(HERE, '..', '..', 'public', 'looks');
const only = process.argv[2] ?? '';
const tmp = mkdtempSync(path.join(tmpdir(), 'looks-drift-'));
const run = spawnSync(
  process.execPath,
  [path.join(HERE, 'snapshot.mjs'), ...(only ? [only] : []), '--out', tmp, '--no-images'],
  { stdio: 'inherit' }
);
if (run.status !== 0) {
  console.error('snapshot failed; drift cannot be judged');
  process.exit(2);
}
const problems = [];
for (const tpl of only ? only.split(',') : ['qamar', 'souq', 'jasmine', 'lamma', 'dahab']) {
  const a = normalise(readFileSync(path.join(COMMITTED, `${tpl}.html`), 'utf8'));
  const b = normalise(readFileSync(path.join(tmp, `${tpl}.html`), 'utf8'));
  problems.push(...diffNormalised(tpl, a, b));
}
if (problems.length) {
  console.error(
    'DRIFT between the committed phones and the live demo stores:\n' + problems.join('\n')
  );
  console.error('Run `npm run looks -w apps/marketing` and commit the result.');
  process.exit(1);
}
console.log('no drift: committed phones match the live demo stores');
