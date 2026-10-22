/**
 * Reads every cron-triggered Inngest function out of `apps/api/src/lib/inngest/functions` (AST, no
 * module loading, so no DB/Redis mocks) and prices it in executions per 30-day month.
 * Used by tests/unit/inngest-cron-budget.test.ts (Ruling INNGEST-BUDGET-1).
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

export interface CronFn {
  id: string;
  file: string;
  cron: string;
  firesPerMonth: number;
  registered: boolean;
}

export const DAYS_PER_MONTH = 30;

function expandField(field: string, min: number, max: number): number[] {
  const out = new Set<number>();
  for (const part of field.split(',')) {
    const [rangePart, stepPart] = part.split('/');
    const step = stepPart ? Number(stepPart) : 1;
    let lo = min;
    let hi = max;
    if (rangePart !== '*') {
      const [a, b] = rangePart!.split('-');
      lo = Number(a);
      hi = b !== undefined ? Number(b) : stepPart ? max : lo;
    }
    if (![lo, hi, step].every(Number.isFinite) || step < 1) {
      throw new Error(`unsupported cron field "${field}"`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return [...out];
}

/** Fires in a 30-day month (day-of-month and day-of-week averaged over the month). */
export function firesPerMonth(cronExpr: string): number {
  const expr = cronExpr.replace(/^TZ=\S+\s+/, '').trim();
  const f = expr.split(/\s+/);
  if (f.length !== 5) throw new Error(`not a 5-field cron: "${cronExpr}"`);
  const [mi, hr, dom, mon, dow] = f as [string, string, string, string, string];
  const perDay = expandField(mi, 0, 59).length * expandField(hr, 0, 23).length;
  const domN = dom === '*' ? null : expandField(dom, 1, 31).length;
  const dowN = dow === '*' ? null : expandField(dow, 0, 7).filter(d => d !== 7).length || 1;
  // vixie cron: if both are restricted the day matches either.
  const dayShare =
    domN === null && dowN === null ? 1 : Math.min(1, (domN ?? 0) / 31 + (dowN ?? 0) / 7);
  const monthShare = mon === '*' ? 1 : expandField(mon, 1, 12).length / 12;
  return Math.ceil(perDay * DAYS_PER_MONTH * dayShare * monthShare);
}

function cronText(n: ts.Expression): string | null {
  if (ts.isStringLiteralLike(n)) return n.text;
  if (ts.isTemplateExpression(n)) {
    // `TZ=${REGION.timezone} 0 6 * * *` -> "TZ=<tz> 0 6 * * *"; the timezone is not a schedule
    return n.head.text + '<tz>' + n.templateSpans.map(s => s.literal.text).join('');
  }
  return null;
}

export function collectCronFunctions(functionsDir: string): CronFn[] {
  const indexSrc = fs.readFileSync(path.join(functionsDir, 'index.ts'), 'utf8');
  const imported = new Set([...indexSrc.matchAll(/from '\.\/([\w-]+)'/g)].map(m => m[1]!));
  const found: CronFn[] = [];
  for (const name of fs.readdirSync(functionsDir)) {
    if (!name.endsWith('.ts') || name === 'index.ts') continue;
    const file = path.join(functionsDir, name);
    const sf = ts.createSourceFile(
      file,
      fs.readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true
    );
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'createFunction' &&
        node.arguments[0] &&
        ts.isObjectLiteralExpression(node.arguments[0])
      ) {
        const cfg = node.arguments[0];
        const prop = (key: string) =>
          cfg.properties.find(
            (p): p is ts.PropertyAssignment =>
              ts.isPropertyAssignment(p) && p.name.getText(sf) === key
          );
        const id = prop('id')?.initializer;
        const triggers = prop('triggers')?.initializer;
        if (id && ts.isStringLiteralLike(id) && triggers && ts.isArrayLiteralExpression(triggers)) {
          for (const t of triggers.elements) {
            if (!ts.isObjectLiteralExpression(t)) continue;
            for (const p of t.properties) {
              if (!ts.isPropertyAssignment(p) || p.name.getText(sf) !== 'cron') continue;
              const raw = cronText(p.initializer);
              if (raw === null) throw new Error(`${name}: cron in ${id.text} is not a literal`);
              found.push({
                id: id.text,
                file: name,
                cron: raw,
                firesPerMonth: firesPerMonth(raw),
                registered: imported.has(name.replace(/\.ts$/, '')),
              });
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return found.sort((a, b) => a.id.localeCompare(b.id));
}
