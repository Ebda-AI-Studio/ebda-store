/**
 * G5: a Workflow handler may only touch the database (or the clock, or randomness) INSIDE
 * `step.run`. Outside a step there is no database connection on workerd and the code is re-executed
 * on every replay, so anything non-deterministic there changes what a replay does.
 *
 * Static audit over every `kind: 'workflow'` function in lib/jobs/jobs-map.ts. A finding is either
 * fixed or listed in RULED with a reason (an await on a pure helper, a clock read that only feeds a
 * step name that is stable per run, ...). Queue-kind functions run whole inside one context and are
 * exempt. `.audit()` prints the findings so a new function is reviewed, not just allowlisted.
 */
import ts from 'typescript';
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { JOBS_MAP } from '@api/lib/jobs/jobs-map';

const DIR = path.resolve(__dirname, '../../apps/api/src/lib/inngest/functions');
const STEP_CALLS = new Set(['run', 'sleep', 'sleepUntil', 'sendEvent']);

export interface Finding {
  job: string;
  rule: 'await-outside-step' | 'clock-outside-step' | 'random-outside-step';
  text: string;
}

/**
 * Reviewed and safe: `[pattern on "job|rule|text", why]`. Ruling G5-1 (docs/RULINGS.md). Every
 * entry must still match a finding (a stale one fails), so this list only ever shrinks.
 */
const key = (f: Finding) => `${f.job}|${f.rule}|${f.text}`;

export const RULED: Array<[RegExp, string]> = [
  [
    /^gold-rate-staleness-watch\.ts#handleGoldRateStalenessWatch\|await-outside-step\|await sendAlert\(/,
    'sendAlert is a Redis throttle key plus one Telegram fetch: no Prisma, so it needs no step connection (the Worker bindings are set in run())',
  ],
  [
    /^(order-created-stuck-sweep|order-status-fanout-stuck-sweep|payment-reconcile-sweep|refund-reversal-stuck-sweep)\.ts#\w+\|clock-outside-step\|Date\.now\(\)$/,
    'sweep cutoffs: a wall-clock read that only parameterises the find step (read inside the step, memoised) or an alert age threshold; a replay or a step retry shifts it by seconds and the next tick re-evaluates, every write is guarded by its own state predicate',
  ],
  [
    /^(order-created-fanout|order-(refunded|status-changed)\.ts#\w+)\|await-outside-step\|await storeMoney\(storeId\)$/,
    'Ruling CF-JOBS-4: reads the store backend flag from D1 (a binding, not a Postgres connection), which only changes while writes are frozen, so every replay of one run sees the same answer; the DO client it returns is used only inside steps',
  ],
  [
    /^order-(refunded|status-changed)\.ts#\w+\|await-outside-step\|await Promise\.allSettled\(/,
    'awaits promises that are each a step.run (parallel steps); no database access in the await itself',
  ],
];

const ruled = (f: Finding): boolean => RULED.some(([re]) => re.test(key(f)));

function isStepCall(n: ts.Node): boolean {
  return (
    ts.isCallExpression(n) &&
    ts.isPropertyAccessExpression(n.expression) &&
    ts.isIdentifier(n.expression.expression) &&
    n.expression.expression.text === 'step' &&
    STEP_CALLS.has(n.expression.name.text)
  );
}

/** A step call, or a helper handed the `step` (it opens its own steps; reviewed in its own file). */
function mentionsStep(n: ts.Node): boolean {
  let hit = false;
  const v = (x: ts.Node): void => {
    if (hit) return;
    if (
      isStepCall(x) ||
      (ts.isCallExpression(x) && x.arguments.some(a => ts.isIdentifier(a) && a.text === 'step'))
    )
      hit = true;
    else ts.forEachChild(x, v);
  };
  v(n);
  return hit;
}

export function auditFile(file: string): Finding[] {
  const sf = ts.createSourceFile(
    file,
    fs.readFileSync(path.join(DIR, file), 'utf8'),
    ts.ScriptTarget.Latest,
    true
  );
  const out: Finding[] = [];
  const short = (n: ts.Node) => n.getText(sf).replace(/\s+/g, ' ').slice(0, 90);

  const scanHandler = (job: string, body: ts.Node): void => {
    // Local helpers (function declarations / const arrows) are called from step bodies or between
    // steps: one that opens steps itself is scanned at its call site, the rest are step bodies.
    const locals = new Map<string, ts.Node>();
    const collect = (n: ts.Node): void => {
      if (ts.isFunctionDeclaration(n) && n.name && n.body) locals.set(n.name.text, n.body);
      if (
        ts.isVariableDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        n.initializer &&
        (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))
      )
        locals.set(n.name.text, n.initializer.body);
      ts.forEachChild(n, collect);
    };
    collect(body);
    const callsStepOpener = (e: ts.Node): boolean => {
      if (mentionsStep(e)) return true;
      let hit = false;
      const w = (x: ts.Node): void => {
        if (hit) return;
        if (ts.isCallExpression(x) && ts.isIdentifier(x.expression)) {
          const lb = locals.get(x.expression.text);
          if (lb && mentionsStep(lb)) hit = true;
        }
        ts.forEachChild(x, w);
      };
      w(e);
      return hit;
    };
    const scanned = new Set<string>();
    const v = (n: ts.Node): void => {
      if (
        (ts.isFunctionDeclaration(n) && n.body !== body) ||
        ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) &&
          ts.isVariableDeclaration(n.parent))
      ) {
        return;
      }
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
        const lb = locals.get(n.expression.text);
        if (lb && mentionsStep(lb) && !scanned.has(n.expression.text)) {
          scanned.add(n.expression.text);
          v(lb);
        }
      }
      if (
        ts.isCallExpression(n) &&
        n.arguments.some(a => ts.isIdentifier(a) && a.text === 'step')
      ) {
        // A helper handed the `step` (stepRunUnlessEmpty, ...): its callbacks are step bodies.
        n.arguments.forEach(a => {
          if (!(ts.isArrowFunction(a) || ts.isFunctionExpression(a))) v(a);
        });
        return;
      }
      if (isStepCall(n)) {
        // The step callback (2nd arg of run) is a step body: skip it. Other args are still outside.
        const call = n as ts.CallExpression;
        call.arguments.forEach((a, i) => {
          const isBody = (ts.isArrowFunction(a) || ts.isFunctionExpression(a)) && i === 1;
          if (!isBody) v(a);
        });
        return;
      }
      if (ts.isAwaitExpression(n) && !callsStepOpener(n.expression)) {
        out.push({ job, rule: 'await-outside-step', text: short(n) });
      }
      if (ts.isCallExpression(n)) {
        const t = n.expression.getText(sf);
        if (t === 'Date.now') out.push({ job, rule: 'clock-outside-step', text: short(n) });
        if (t === 'Math.random' || /randomUUID$/.test(t))
          out.push({ job, rule: 'random-outside-step', text: short(n) });
      }
      if (
        ts.isNewExpression(n) &&
        n.expression.getText(sf) === 'Date' &&
        (n.arguments?.length ?? 0) === 0
      ) {
        out.push({ job, rule: 'clock-outside-step', text: short(n) });
      }
      ts.forEachChild(n, v);
    };
    v(body);
  };

  // Top-level helpers that take the `step` (handlers are often `({ step }) => helper(step)`).
  let fileHasWorkflow = false;
  const helpers: Array<{ name: string; body: ts.Node }> = [];
  const takesStep = (fn: ts.SignatureDeclaration): boolean =>
    fn.parameters.some(p => /\bstep\b/.test(p.name.getText(sf))); // `step` or `{ step, ... }`
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name && st.body && takesStep(st)) {
      helpers.push({ name: st.name.text, body: st.body });
    }
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        const init = d.initializer;
        if (
          init &&
          ts.isIdentifier(d.name) &&
          (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) &&
          takesStep(init)
        ) {
          helpers.push({ name: d.name.text, body: init.body });
        }
      }
    }
  }

  const visit = (n: ts.Node): void => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === 'createFunction' &&
      n.arguments[0] &&
      ts.isObjectLiteralExpression(n.arguments[0])
    ) {
      const idProp = n.arguments[0].properties.find(
        (p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText(sf) === 'id'
      );
      const id = idProp?.initializer;
      const handler = n.arguments[n.arguments.length - 1];
      if (id && ts.isStringLiteralLike(id) && JOBS_MAP[id.text]?.kind === 'workflow') {
        fileHasWorkflow = true;
        if (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler)) {
          scanHandler(id.text, handler.body);
        } else {
          out.push({ job: id.text, rule: 'await-outside-step', text: 'handler is not inline' });
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  if (fileHasWorkflow) for (const h of helpers) scanHandler(`${file}#${h.name}`, h.body);
  return out;
}

export function auditAll(): Finding[] {
  return fs
    .readdirSync(DIR)
    .filter(f => f.endsWith('.ts') && f !== 'index.ts')
    .flatMap(auditFile);
}

describe('workflow handlers only do I/O and read the clock inside steps', () => {
  it('scans workflow functions (a scanner that sees nothing passes anything)', () => {
    const jobs = new Set(
      Object.entries(JOBS_MAP)
        .filter(([, e]) => e.kind === 'workflow')
        .map(([id]) => id)
    );
    expect(jobs.size).toBeGreaterThan(40);
  });

  it('has no unreviewed finding', () => {
    const open = auditAll().filter(f => !ruled(f));
    if (process.env.JOBS_AUDIT) console.log(open.map(key).join('\n'));
    expect(open.map(key)).toEqual([]);
  });

  it('RULED has no stale entry', () => {
    const live = auditAll().map(key);
    expect(RULED.filter(([re]) => !live.some(k => re.test(k))).map(([re]) => String(re))).toEqual(
      []
    );
  });
});
