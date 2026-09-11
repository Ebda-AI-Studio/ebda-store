/**
 * A ZAP suppression must not outlive its reason.
 *
 * `.zap/rules.tsv` IGNOREs four alerts that fire on every nightly run. Each is
 * defensible today — but `IGNORE` is GLOBAL (rules.tsv has no URL scoping), so
 * each one also hides the not-yet-accepted variant of its own class: a
 * genuinely over-permissive `script-src *` on a merchant storefront, a CSP
 * dropped from a real 200 response, a future form-post surface with no token,
 * a third-party `<script src>` with no SRI.
 *
 * The file already said "re-examine when the CSP work lands". Nothing enforced
 * it, which is the difference between a decision and a hope. This test is the
 * enforcement: every IGNORE carries `review-by:<date>`, and the suite reddens
 * the day one passes. The fix at that point is to re-justify with a new date
 * or to delete the line — not to bump it without looking.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const RULES = join(__dirname, '../../.zap/rules.tsv');

interface Rule {
  id: string;
  action: string;
  comment: string;
  reviewBy: string | null;
  line: number;
}

/** The parser, taking text — so the guard test can feed it a known fixture. */
function parseTsv(text: string): Rule[] {
  const out: Rule[] = [];
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const [id, action, ...rest] = line.split('\t');
    if (!id || !action) return;
    const comment = rest.join('\t');
    const m = comment.match(/review-by:(\d{4}-\d{2}-\d{2})/);
    out.push({ id, action, comment, reviewBy: m ? m[1] : null, line: i + 1 });
  });
  return out;
}

function parseRules(): Rule[] {
  return parseTsv(readFileSync(RULES, 'utf8'));
}

describe('.zap/rules.tsv suppressions', () => {
  const rules = parseRules();
  const ignores = rules.filter(r => r.action === 'IGNORE');

  it('parses the file (guards against an empty-set pass)', () => {
    // Without this, a parser that silently returns [] would make every
    // assertion below vacuously true — the exact shape of a gate that cannot
    // fail.
    //
    // NOT a count floor. `.zap/rules.tsv` says 10055 and 10038 come OFF the
    // list when the CSP work lands, so a `>= N` assertion would redden on the
    // very cleanup the file instructs — with a message pointing at a parser
    // bug rather than at the legitimate deletion. Assert the parser WORKS
    // instead, against a fixture it cannot drift away from.
    expect(rules.length).toBeGreaterThan(0);

    const fixture = parseTsv(
      [
        '# a comment',
        '',
        '10001\tIGNORE\treason here; review-by:2030-01-01',
        '10002\tWARN\tplain',
      ].join('\n')
    );
    expect(fixture).toHaveLength(2);
    expect(fixture[0]).toMatchObject({ id: '10001', action: 'IGNORE', reviewBy: '2030-01-01' });
    expect(fixture[1]).toMatchObject({ id: '10002', action: 'WARN', reviewBy: null });
  });

  it.each(parseRules().filter(r => r.action === 'IGNORE'))(
    'rule $id carries a review-by date',
    (rule: Rule) => {
      expect(
        rule.reviewBy,
        `.zap/rules.tsv:${rule.line} — rule ${rule.id} is IGNOREd with no ` +
          `review-by:<YYYY-MM-DD>. A global IGNORE hides the not-yet-accepted ` +
          `variant of its class, so it needs an expiry.`
      ).not.toBeNull();
    }
  );

  it.each(parseRules().filter(r => r.action === 'IGNORE'))(
    'rule $id has a parseable review date',
    (rule: Rule) => {
      if (!rule.reviewBy) return; // the previous test owns that failure
      const due = new Date(`${rule.reviewBy}T00:00:00Z`);
      expect(Number.isNaN(due.getTime()), `${rule.id}: unparseable date`).toBe(false);
    }
  );

  /**
   * EXPIRY IS NOT ASSERTED HERE — deliberately.
   *
   * This file runs in `tests/unit`, which gates every PR. An expiry check in
   * it would mean that on 2026-12-31 every unrelated pull request, a hotfix
   * included, fails CI on a ZAP suppression — with no way to tell "this PR
   * broke something" from "a calendar date passed". A gate that reddens good
   * work on a timer is worse than no gate.
   *
   * The expiry runs in the NIGHTLY zap-baseline workflow instead
   * (`npm run check:zap-review-dates`), where it alerts through the same
   * Telegram path as a scan failure and blocks nobody. The half that is
   * deterministic — every IGNORE HAS a date — stays here, PR-blocking, because
   * it can only fail in response to something the author actually did.
   */

  it('every rule uses a known action', () => {
    for (const r of rules) expect(['IGNORE', 'WARN', 'FAIL']).toContain(r.action);
  });
});
