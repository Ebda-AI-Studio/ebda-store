/**
 * Every id `.zap/rules.tsv` IGNOREs must be documented in
 * `docs/security/zap-triage-2026-07-15.md`'s Accepted table.
 *
 * 10055, 10038 and 10202 were added to rules.tsv on 2026-09-11 alongside the
 * original nine, but the doc's Accepted table was never updated to match — it
 * still only listed the first nine ids. `.zap/rules.tsv` says "this table is
 * the reasoning, that file is the mechanism"; a suppression with no row in
 * the reasoning table reads as undocumented, however good the inline comment
 * in rules.tsv is.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const RULES = join(__dirname, '../../.zap/rules.tsv');
const DOC = join(__dirname, '../../docs/security/zap-triage-2026-07-15.md');

function ignoredIds(): string[] {
  return readFileSync(RULES, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'))
    .map(l => l.split('\t'))
    .filter(([, action]) => action === 'IGNORE')
    .map(([id]) => id);
}

describe('zap-triage doc stays in parity with .zap/rules.tsv (#1755)', () => {
  const ids = ignoredIds();
  const doc = readFileSync(DOC, 'utf8');

  it('finds IGNOREd rules (guards against an empty-set pass)', () => {
    expect(ids.length).toBeGreaterThan(0);
    expect(ids).toContain('10055');
    expect(ids).toContain('10038');
    expect(ids).toContain('10202');
  });

  it.each(ids)('rule %s IGNOREd in rules.tsv is documented somewhere in the triage doc', id => {
    expect(doc.includes(id), `${id} is IGNOREd in .zap/rules.tsv but not mentioned in ${DOC}`).toBe(
      true
    );
  });
});
