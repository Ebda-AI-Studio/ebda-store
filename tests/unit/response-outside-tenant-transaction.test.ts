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

const API_SRC = path.resolve(__dirname, '../../apps/api/src');
const SCANNED_DIRS = ['routes', 'middleware'];

/** Opens a tenant-scoped (or RLS-bypass) transaction whose callback runs handler code. */
const TX_OPENER = /\b(runInTenantContext|withRlsBypass|withTenantContext)\s*(<[\s\S]*?>)?\s*\(/g;
/** Sends bytes to the Express client. */
const RESPONSE_SEND = /\bres\.(json|send|end|sendFile|download|redirect|sendStatus)\s*\(/g;

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

/** Index of the `)` closing the `(` at `open`, by paren depth. */
function matchingParen(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return src.length;
}

function scan(): Finding[] {
  const findings: Finding[] = [];
  for (const file of sourceFiles()) {
    const src = fs.readFileSync(file, 'utf-8');
    TX_OPENER.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TX_OPENER.exec(src)) !== null) {
      const open = src.indexOf('(', m.index + m[1].length);
      if (open === -1) continue;
      const close = matchingParen(src, open);
      const body = src.slice(open, close);
      RESPONSE_SEND.lastIndex = 0;
      let s: RegExpExecArray | null;
      while ((s = RESPONSE_SEND.exec(body)) !== null) {
        findings.push({
          file: path.relative(API_SRC, file),
          line: src.slice(0, open + s.index).split('\n').length,
          opener: m[1],
          send: s[0],
        });
      }
    }
  }
  return findings;
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
    RESPONSE_SEND.lastIndex = 0;
    const open = bad.indexOf('(', bad.indexOf('runInTenantContext'));
    const body = bad.slice(open, matchingParen(bad, open));
    expect(RESPONSE_SEND.test(body)).toBe(true);
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
    RESPONSE_SEND.lastIndex = 0;
    const open = good.indexOf('(', good.indexOf('runInTenantContext'));
    const body = good.slice(open, matchingParen(good, open));
    expect(RESPONSE_SEND.test(body)).toBe(false);
  });
});
