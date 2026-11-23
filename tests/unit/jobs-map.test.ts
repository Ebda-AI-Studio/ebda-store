/**
 * G5: the job map is the single table of "which Cloudflare primitive runs which Inngest function".
 * It must list exactly the functions the registry contains (110 today), no more, no fewer.
 */
import ts from 'typescript';
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { JOBS_MAP, JOB_GROUPS } from '@api/lib/jobs/jobs-map';

const DIR = path.resolve(__dirname, '../../apps/api/src/lib/inngest/functions');

interface Found {
  id: string;
  cron: boolean;
  event: boolean;
}

function scan(): Found[] {
  const out: Found[] = [];
  for (const name of fs.readdirSync(DIR)) {
    if (!name.endsWith('.ts') || name === 'index.ts') continue;
    const sf = ts.createSourceFile(
      name,
      fs.readFileSync(path.join(DIR, name), 'utf8'),
      ts.ScriptTarget.Latest,
      true
    );
    const visit = (n: ts.Node): void => {
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === 'createFunction' &&
        n.arguments[0] &&
        ts.isObjectLiteralExpression(n.arguments[0])
      ) {
        const cfg = n.arguments[0];
        const prop = (k: string) =>
          cfg.properties.find(
            (p): p is ts.PropertyAssignment =>
              ts.isPropertyAssignment(p) && p.name.getText(sf) === k
          );
        const id = prop('id')?.initializer;
        const trig = prop('triggers')?.initializer;
        if (id && ts.isStringLiteralLike(id)) {
          const text = trig ? trig.getText(sf) : '';
          out.push({ id: id.text, cron: /cron\s*:/.test(text), event: /event\s*:/.test(text) });
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}

const found = scan();

describe('JOBS_MAP', () => {
  it('finds the registry (a scanner that sees nothing would pass anything)', () => {
    expect(found.length).toBe(110);
  });

  it('lists exactly the registered functions', () => {
    expect(Object.keys(JOBS_MAP).sort()).toEqual(found.map(f => f.id).sort());
  });

  it('every entry has a known group, and trigger kind matches the function', () => {
    for (const f of found) {
      const e = JOBS_MAP[f.id]!;
      expect(JOB_GROUPS, f.id).toContain(e.group);
      if (f.cron && !f.event) expect(e.trigger, f.id).toBe('cron');
      if (f.event && !f.cron) expect(e.trigger, f.id).toBe('event');
    }
  });

  it('alarm candidates are scheduled jobs', () => {
    for (const [id, e] of Object.entries(JOBS_MAP)) if (e.alarm) expect(e.trigger, id).toBe('cron');
  });

  it('the failure watcher ports last (it receives the failure events of every other job)', () => {
    expect(JOBS_MAP['alerts-failure-watch']!.group).toBe('8-failure-watch');
    expect(JOB_GROUPS[JOB_GROUPS.length - 1]).toBe('8-failure-watch');
  });
});
