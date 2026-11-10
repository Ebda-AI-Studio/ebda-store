/**
 * A handler must not send its response from INSIDE a tenant transaction.
 *
 * ## The defect this gate exists for
 *
 * `middleware/request-transaction.ts` gives every route mounted under
 * `tenantContext` / `userContext` the property that a 2xx reaching the client
 * is a COMMITTED 2xx. Routes mounted BARE — `payments/*` is the important one —
 * do not get that middleware, and instead open their own
 * `runInTenantContext(...)` inside the handler. If such a handler calls
 * `res.json(...)` from inside that callback, the response is flushed while the
 * transaction is still open and Postgres COMMITs afterwards: the client is told
 * "paid" before the payment row is durable.
 *
 * That was not hypothetical. `POST /payments/create` did exactly this, and it
 * was measured on 2026-09-08 against a local Postgres:
 *
 *     callback-returned (COMMIT starts)  440.336 ms
 *     http-response-finished             440.435 ms   <- response on the wire
 *     client-received-body               440.720 ms   <- client has the 200
 *     COMMITTED                          440.811 ms   <- 0.376 ms too late
 *
 * The behavioural assertion that caught it — "the payment row is durable, read
 * from a separate connection with no barrier" in
 * `tests/integration/export-response-lifecycle.test.ts` — is *probabilistic*:
 * it went red on a loaded CI runner and green on a developer laptop. That is
 * exactly the shape of bug this repo has been burned by, so it gets a
 * DETERMINISTIC gate as well. This is that gate.
 *
 * ## Scope, and why it is what it is
 *
 * Only `apps/api/src/routes/**` and `apps/api/src/middleware/**` are scanned,
 * because there `res` is unambiguously the Express response. Scanning wider
 * produces false positives wherever `res` is a `fetch` Response and
 * `res.json()` READS a body — the opposite of sending one. Narrow scope beats an allowlist that would rot.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import ts from 'typescript';

const API_SRC = path.resolve(__dirname, '../../apps/api/src');
const SCANNED_DIRS = ['routes', 'middleware'];

/** Opens a tenant-scoped (or RLS-bypass) transaction whose callback runs handler code. */
const TX_OPENERS = new Set(['runInTenantContext', 'withRlsBypass', 'withTenantContext']);
/** Sends bytes to the Express client. */
const RESPONSE_SENDS = new Set([
  'json',
  'send',
  'end',
  'sendFile',
  'download',
  'redirect',
  'sendStatus',
]);

interface Finding {
  file: string;
  line: number;
  opener: string;
  send: string;
}

/** Every `.ts` file under the scanned dirs, tests excluded. */
function sourceFiles(): string[] {
  const out: string[] = [];
  for (const dir of SCANNED_DIRS) {
    const root = path.join(API_SRC, dir);
    const walk = (d: string): void => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (entry.name === '__tests__') continue;
          walk(path.join(d, entry.name));
        } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
          out.push(path.join(d, entry.name));
        }
      }
    };
    walk(root);
  }
  return out;
}

/** Name a call is made through: `f(...)` -> f, `a.f(...)` -> f. */
function calleeName(call: ts.CallExpression): string | undefined {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return undefined;
}

/** True when a call/property chain starts at the identifier `res` (`res.json`, `res.status(200).json`). */
function startsAtRes(e: ts.Expression): boolean {
  for (;;) {
    if (ts.isCallExpression(e) || ts.isPropertyAccessExpression(e)) e = e.expression;
    else if (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isAsExpression(e))
      e = e.expression;
    else return ts.isIdentifier(e) && e.text === 'res';
  }
}

/**
 * Structural, not textual: the source is PARSED, so a `)` inside a string, regex or comment cannot end
 * a transaction callback early (the old paren counter did), a `res.json(` named in a comment is not a
 * send, and a chained send (`res.status(201).json(...)`) is seen. Behaviour is not practical: the
 * property is "no handler under routes/ or middleware/ has this shape", over every route.
 */
function findingsIn(src: string, file: string): Finding[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
  const findings: Finding[] = [];
  const sends = (n: ts.Node, opener: string): void => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      RESPONSE_SENDS.has(n.expression.name.text) &&
      startsAtRes(n.expression.expression)
    )
      findings.push({
        file,
        line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
        opener,
        send: `res.${n.expression.name.text}(`,
      });
    ts.forEachChild(n, c => sends(c, opener));
  };
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const name = calleeName(n);
      if (name && TX_OPENERS.has(name)) for (const arg of n.arguments) sends(arg, name);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return findings;
}

function scan(): Finding[] {
  return sourceFiles().flatMap(file =>
    findingsIn(fs.readFileSync(file, 'utf-8'), path.relative(API_SRC, file))
  );
}

describe('no response is sent from inside a tenant transaction', () => {
  it('finds zero handlers that flush the client before their COMMIT', () => {
    const findings = scan();
    const rendered = findings.map(f => `${f.file}:${f.line} — ${f.send} inside ${f.opener}(...)`);
    // A finding here means: that route answers the client while its own
    // transaction is still open, so its 2xx does not mean "committed". Move
    // the `res.*` call AFTER the transaction resolves — return the payload
    // from the callback and send it outside, the way `payment.routes.ts`
    // POST /create does.
    expect(rendered).toEqual([]);
  });

  it('is actually looking at something (the scanner is not vacuously green)', () => {
    // A gate that silently scans zero files reports success forever. Assert
    // the corpus is real and that the scanner can SEE the pattern it hunts,
    // by running it over a known-bad synthetic body.
    expect(sourceFiles().length).toBeGreaterThan(40);

    const bad = `
      await runInTenantContext(order.storeId, async () => {
        const payment = await prisma.payment.create({ data: {} });
        res.json({ ok: payment.id });
      });
    `;
    expect(findingsIn(bad, 'bad.ts').map(f => f.send)).toEqual(['res.json(']);
    // the chained form, and a `)` inside a string before the send, are seen too
    expect(
      findingsIn(
        `await withRlsBypass(async () => { log(')'); res.status(201).json({}); });`,
        'bad2.ts'
      )
    ).toHaveLength(1);
  });

  it('does not fire on a response sent AFTER the transaction resolves', () => {
    // The shape the fix uses must stay green, or the gate would push authors
    // back into the defect.
    const good = `
      const payload = await runInTenantContext(order.storeId, async () => {
        const payment = await prisma.payment.create({ data: {} });
        return { status: 200, body: { id: payment.id } };
      });
      res.status(payload.status).json(payload.body);
    `;
    expect(findingsIn(good, 'good.ts')).toEqual([]);
    // a send named only in a comment inside the callback is not a send
    expect(
      findingsIn(
        `await runInTenantContext(id, async () => { /* res.json(x) */ return 1; });`,
        'c.ts'
      )
    ).toEqual([]);
  });
});
