/**
 * The editor control matrix (plan Task 5): the committed files are current,
 * every not-wired row is accepted in baseline.json with a reason, and the
 * baseline can only shrink. `EDITOR_MATRIX_WRITE=1` regenerates the files
 * (`npm run editor:matrix`).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  BASELINE_JSON,
  MATRIX_JSON,
  MATRIX_MD,
  NOT_WIRED,
  buildMatrix,
  readBaseline,
  renderMarkdown,
} from '../../scripts/editor-audit/gen-matrix';

const root = path.resolve(__dirname, '../..');
const live = buildMatrix();

describe('editor matrix', () => {
  if (process.env.EDITOR_MATRIX_WRITE === '1') {
    it('writes the generated files', () => {
      writeFileSync(path.join(root, MATRIX_JSON), JSON.stringify(live, null, 2) + '\n');
      writeFileSync(path.join(root, MATRIX_MD), renderMarkdown(live));
      // The baseline only ever SHRINKS here: a row that is wired (or gone) leaves it. Accepting a new
      // gap is a deliberate edit of baseline.json (or EDITOR_MATRIX_SEED_BASELINE=1 once, at creation).
      if (process.env.EDITOR_MATRIX_SEED_BASELINE !== '1') {
        const byId = new Map(live.rows.map(r => [r.id, r.status]));
        const kept = readBaseline().filter(b => byId.get(b.id) === b.status);
        writeFileSync(path.join(root, BASELINE_JSON), JSON.stringify(kept, null, 2) + '\n');
      }
      if (process.env.EDITOR_MATRIX_SEED_BASELINE === '1') {
        const seed = live.rows
          .filter(r => NOT_WIRED.includes(r.status))
          .map(r => ({
            id: r.id,
            status: r.status,
            reason:
              r.status === 'classic-only'
                ? `open: ${r.capability ?? 'classic'} moves into the visual editor (plan Tasks 6 to 8)`
                : 'open: template-aware controls and no-op removal (plan Task 10)',
          }));
        writeFileSync(path.join(root, BASELINE_JSON), JSON.stringify(seed, null, 2) + '\n');
      }
      expect(true).toBe(true);
    });
    return;
  }

  it('the committed matrix is current (run `npm run editor:matrix`)', () => {
    const committed = JSON.parse(readFileSync(path.join(root, MATRIX_JSON), 'utf8'));
    expect(JSON.parse(JSON.stringify(live))).toEqual(committed);
    expect(readFileSync(path.join(root, MATRIX_MD), 'utf8')).toBe(renderMarkdown(live));
  });

  it('every not-wired row is accepted in baseline.json, and each baseline row is still not wired', () => {
    const base = readBaseline();
    const byId = new Map(live.rows.map(r => [r.id, r]));
    const accepted = new Map(base.map(b => [b.id, b]));
    const unaccepted = live.rows.filter(r => NOT_WIRED.includes(r.status) && !accepted.has(r.id));
    expect(unaccepted.map(r => `${r.id} ${r.status}`)).toEqual([]);
    // a fixed row must leave the baseline, so the list only shrinks
    const stale = base.filter(b => byId.get(b.id)?.status !== b.status);
    expect(stale.map(b => `${b.id} (${b.status} -> ${byId.get(b.id)?.status ?? 'gone'})`)).toEqual(
      []
    );
    for (const b of base) expect(b.reason.length).toBeGreaterThan(10);
  });

  it('covers every built look and every template section type of the registry', () => {
    expect(live.coverage.looks).toContain('qamar.atelier');
    expect(live.coverage.sectionTypesMissing).toEqual([]);
  });

  it('pending-template rows are reported, never failed', () => {
    const pending = live.rows.filter(r => r.status === 'pending-template');
    for (const r of pending) expect(r.evidence).toBe('mix');
  });

  // The method is only trusted if it reproduces cases whose answer is known from the code
  // (plan Task 1 step 5 of the template editor pass).
  it('hand-verified cases: a wired control, a dead control, a variant with no control', () => {
    const row = (id: string) => live.rows.find(r => r.id === id);
    // (a) the chips layout of the category row is read by the Qamar skin and changes its HTML
    expect(row('qamar|section:category-grid|layout')).toMatchObject({
      status: 'wired',
      evidence: 'static+probe',
    });
    // (b) the hero comment says padding does not apply to the hero wrapper: flipping it changes nothing
    expect(row('qamar|section:hero|paddingTop')?.status).toBe('no-op');
    // (c) a look that uses a design key the editor has no control for is `missing`
    expect(row('qamar.atelier|section:category-grid|design:layoutMobile')?.status).toBe('missing');
  });
});
