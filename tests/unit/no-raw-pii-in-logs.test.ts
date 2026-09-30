/**
 * No logger call in apps/api may receive a raw email address or phone number.
 *
 * Application logs ship to the off-platform log drain (Axiom, 30-day
 * retention). Issue 2390: PR 2388 masked the SMS recipient with `maskPhone`,
 * but its email twin (`email-queue.service.ts` logging `to` on every send) and
 * nine other sites (account lockout, socket connect/disconnect, provisioning,
 * invoice email, contact form, low-stock recipient, alert poller sender, the
 * WhatsApp bridge's hand-rolled `.slice(-4)`) still wrote the raw value.
 *
 * This walks every non-test .ts file under apps/api/src with the TypeScript
 * AST and inspects each object-literal argument (nested literals included) of
 * a `logger.*` / `log.*` / `console.*` call. A property is PII-shaped when its
 * KEY names a contact (`to`, `from`, `cc`, `recipient`, `*email`, `*phone`,
 * `*mobile`) or its VALUE is an identifier / member ending in one
 * (`{ id: user.email }`). A PII-shaped property passes only when its value is
 * a call to a `mask*` / `redact*` / `hash*` helper, a literal, a `.length`, or
 * a boolean (`!!x`, `typeof x`).
 *
 * Out of scope (Ruling LOG-PII-1): spread properties (`{ ...ctx }`) and opaque
 * third-party response bodies (`body: json`) — their content is not visible
 * statically.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const API_SRC = join(__dirname, '../../apps/api/src');

const LEVELS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'log']);
const RECEIVER = /(^|\.)(logger|log|console)$/i;
const PII_KEY =
  /^(to|from|cc|bcc|replyTo|recipients?)$|(email|phone|mobile|msisdn)(address|number)?$/i;
const PII_LEAF = /(email|phone|mobile|msisdn)(address|number)?$/i;
const SAFE_CALL = /^(mask|redact|hash)/i;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === 'node_modules' ? [] : walk(p);
    return /\.ts$/.test(name) && !/\.(test|spec|d)\.ts$/.test(name) ? [p] : [];
  });
}

/** The trailing name of an expression: `user.email` → `email`, `to` → `to`. */
function leafName(e: ts.Expression): string | null {
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  if (ts.isNonNullExpression(e) || ts.isParenthesizedExpression(e) || ts.isAsExpression(e))
    return leafName(e.expression);
  return null;
}

function isSafeValue(e: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e))
    return isSafeValue(e.expression);
  if (ts.isCallExpression(e)) {
    const name = leafName(e.expression);
    return name !== null && SAFE_CALL.test(name);
  }
  if (
    ts.isStringLiteral(e) ||
    ts.isNumericLiteral(e) ||
    ts.isNoSubstitutionTemplateLiteral(e) ||
    e.kind === ts.SyntaxKind.TrueKeyword ||
    e.kind === ts.SyntaxKind.FalseKeyword ||
    e.kind === ts.SyntaxKind.NullKeyword ||
    ts.isTypeOfExpression(e)
  )
    return true;
  if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) return true;
  if (ts.isPropertyAccessExpression(e) && e.name.text === 'length') return true;
  if (ts.isTemplateExpression(e))
    return e.templateSpans.every(s => {
      const n = leafName(s.expression);
      return n === null || !PII_LEAF.test(n) || isSafeValue(s.expression);
    });
  return false;
}

export function findRawPiiLogFields(source: string, file = 'input.ts'): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const out: string[] = [];

  const checkObject = (obj: ts.ObjectLiteralExpression) => {
    for (const p of obj.properties) {
      let key: string;
      let value: ts.Expression;
      if (ts.isShorthandPropertyAssignment(p)) {
        key = p.name.text;
        value = p.name;
      } else if (ts.isPropertyAssignment(p)) {
        key = p.name.getText(sf).replace(/^['"`]|['"`]$/g, '');
        value = p.initializer;
      } else continue;
      if (ts.isObjectLiteralExpression(value)) {
        checkObject(value);
        continue;
      }
      const leaf = leafName(value);
      const piiShaped = PII_KEY.test(key) || (leaf !== null && PII_LEAF.test(leaf));
      if (piiShaped && !isSafeValue(value)) {
        const { line } = sf.getLineAndCharacterOfPosition(p.getStart(sf));
        out.push(`${file}:${line + 1} ${key}: ${value.getText(sf)}`);
      }
    }
  };

  const visit = (n: ts.Node) => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      LEVELS.has(n.expression.name.text) &&
      RECEIVER.test(n.expression.expression.getText(sf))
    ) {
      for (const a of n.arguments) if (ts.isObjectLiteralExpression(a)) checkObject(a);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

describe('no raw email / phone in apps/api logger calls (issue 2390)', () => {
  it('every logger field carrying an email or phone is masked', () => {
    const files = walk(API_SRC);
    expect(files.length).toBeGreaterThan(300); // positive control: the walk found the tree
    const violations = files.flatMap(f =>
      findRawPiiLogFields(readFileSync(f, 'utf8'), relative(API_SRC, f))
    );
    expect(violations).toEqual([]);
  });

  // Positive controls: the scanner must actually flag the shapes the issue names.
  it.each([
    [`logger.info({ emailId: e.id, to: email.options.to }, 'sent')`],
    [`logger.error({ err, orderId, to }, 'failed')`],
    [`logger.warn({ email }, 'locked')`],
    [`logger.info({ email: user.email }, 'connected')`],
    [`logger.info({ recipient: scan.recipientEmail }, 'x')`],
    [`logger.info({ customerPhone: customerPhone.slice(-4) }, 'x')`],
    [`logger.info({ id: order.customerEmail }, 'x')`],
    [`logger.info({ meta: { phone: p } }, 'x')`],
    [`this.log.info({ to }, 'x')`],
    [`console.error({ phone: sms.recipientPhone })`],
  ])('flags %s', src => {
    expect(findRawPiiLogFields(src)).toHaveLength(1);
  });

  it.each([
    [`logger.info({ emailId: e.id, to: maskEmailList(e.options.to) }, 'sent')`],
    [`logger.warn({ email: maskEmail(email) }, 'locked')`],
    [`logger.info({ to: maskPhone(to) }, 'sent')`],
    [`logger.info({ customerPhone: '[REDACTED]' }, 'x')`],
    [`logger.info({ hasEmail: !!user.email, emailsSent: 3, emailed }, 'x')`],
    [`logger.info({ from: \`\${m.width}x\${m.height}\` }, 'x')`],
    [`logger.info({ recipientPhoneHash }, 'x')`],
    [`cache.set({ email })`],
  ])('passes %s', src => {
    expect(findRawPiiLogFields(src)).toEqual([]);
  });
});
