/**
 * No log call anywhere in the monorepo may receive a raw email address or
 * phone number.
 *
 * Application logs ship off-platform: apps/api to the Axiom drain (30-day
 * retention), apps/web / apps/orders / apps/admin server code to Cloudflare
 * Workers logs. Issue 2390: PR 2388 masked the SMS recipient with `maskPhone`,
 * but fourteen sibling fields still wrote the raw value. Issues 2392 / 2394:
 * the first gate still missed a `...scanResult` spread carrying the owner
 * email, calls through a bound level function (`const log =
 * logger.warn.bind(logger); log({ … })`), and the whole of apps/web + orders.
 *
 * This walks every non-test .ts/.tsx file under apps/{api,web,orders,admin}/src
 * and packages/{shared,database,ui} with the TypeScript AST. A LOG CALL is:
 *   - `<logger>.<level>(…)` or `<logger>[level](…)`, where `<logger>` is
 *     `logger` / `log` / `console` (optionally as a member: `this.log`,
 *     `req.log`), a local alias of one (`const l = logger`, `const l =
 *     logger.child(…)`), or a binding annotated `Logger`;
 *   - `<logger>.child({…})` — child bindings are written on every line;
 *   - `fn(…)` where `fn` is bound to a level function (`logger.warn`,
 *     `logger.warn.bind(logger)`, either branch of a conditional).
 * Every argument of a log call is inspected:
 *   - object literals (nested included): a property is PII-shaped when its KEY
 *     names a contact (`to`, `from`, `cc`, `recipient`, `*email`, `*phone`,
 *     `*mobile`) or its VALUE is an identifier / member ending in one
 *     (`{ id: user.email }`). It passes only when the value is a `mask*` /
 *     `redact*` / `hash*` call, a literal, a `.length`, or a boolean.
 *   - spreads (`{ ...ctx }`) and an opaque FIRST argument (`logger.info(ctx,
 *     'x')` — pino's merge object, written key by key exactly like a spread;
 *     issue 2396): their content is not visible to a syntax walk, so each must
 *     be listed in REVIEWED_SPREADS with the reason it carries no contact. A new
 *     one fails until someone reads it; a listed one that no longer exists
 *     fails too, so the list stays exact.
 *   - array literals are walked element by element (`{ items: [{ email }] }`).
 *   - template / concatenated messages: every interpolated expression is held
 *     to the same rule (`` `sent to ${email}` `` fails).
 *   - bare positional values (`console.log('x', user.email)`).
 *
 * Out of reach (Ruling LOG-PII-1): opaque third-party response bodies
 * (`body: json`) whose content is decided by the provider.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const REPO = join(__dirname, '../..');
const ROOTS = [
  'apps/api/src',
  'apps/web/src',
  'apps/orders/src',
  'apps/admin/src',
  'packages/shared/src',
  'packages/database/src',
  'packages/database/prisma',
  'packages/database/scripts',
  'packages/ui/src',
];

const LEVELS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'log']);
const RECEIVER = /(^|\.)(logger|log|console)$/i;
const LOGGER_TYPE = /(^|\.)(\w*Logger)$/;
const PII_KEY =
  /^(to|from|cc|bcc|replyTo|recipients?)$|(email|phone|mobile|msisdn)(address|number)?$/i;
const PII_LEAF = /(email|phone|mobile|msisdn)(address|number)?$/i;
const SAFE_CALL = /^(mask|redact|hash)/i;

/**
 * Every spread inside a log object, keyed `<repo path>|<spread expression>`,
 * with the reason it carries no raw contact. Read the spread source before
 * adding a line.
 */
const REVIEWED_SPREADS: Record<string, string> = {
  'apps/api/src/lib/inngest/functions/audit-log-archive.ts|cf':
    'archive-cloudflare-audit step result → { skipped, d1, stores, storeRows } counts only',
  'apps/api/src/services/billing/payments-reconcile.service.ts|report':
    'ReconcileReport → linked / rolledBack / confirmed counts (undecided is logged as a count only)',
  'apps/api/src/app.ts|unset':
    'billingProviderUnsetWarning() → a fixed config warning string; no contact data',
  'apps/api/src/lib/database-role-guard.ts|detail':
    'refuse() detail → { err: message } | { rowCount } | { currentUser: DB role name, rol* flags }',
  'apps/api/src/lib/inngest/functions/accounting-post-refund-journal.ts|partialResult':
    'postPartialReturnJournal → { posted: number; skipped?: string }',
  'apps/api/src/lib/inngest/functions/ai-autofill-sweep.ts|res':
    'sweepStore → { products: number; filled: number }',
  'apps/api/src/lib/inngest/functions/analytics-daily-rollup.ts|result':
    'RollupResult → cohortRows / funnelDays / rfmCustomers counts',
  'apps/api/src/lib/inngest/functions/campaign-send.ts|result':
    'BatchResult → sent / failed / skipped counts, cancelled / deferred flags',
  'apps/api/src/lib/inngest/functions/gsc-ingest.ts|result':
    "RunGscIngestResult → { skipped?: 'no_domain' | 'no_access'; date }",
  'apps/api/src/lib/inngest/functions/stock-deadstock-scan.ts|result':
    'DeadstockScanResult → scanned / flagged / expiredCount',
  'apps/api/src/lib/inngest/functions/stock-reorder-scan.ts|result':
    'ReorderScanResult → scanned / suggested / expiredCount',
  'apps/api/src/lib/inngest/functions/catalog-import-uploads-sweep.ts|result':
    'bare first arg: SweepResult → { storesScanned; objectsSeen; expired; deleted; failed; capped } counts and a flag',
  'apps/api/src/lib/inngest/functions/r2-orphan-sweep.ts|summary':
    'bare first arg: { totalKeys; totalBytes; orphanCount; orphanBytes; skippedYoung; applyDeletes } — counts and a flag',
  'apps/api/src/lib/inngest/functions/warehouse-reconcile-sweep.ts|result':
    'spread: backfillReconcileAll → { skusReconciled; skusFailed }; bare first arg: WarehouseSweepResult → store / SKU counts',
  'apps/api/src/services/gmail-alert-poller.service.ts|result':
    'bare first arg: PollResult → { scanned; forwarded; failed; skipped } counts',
  'apps/api/src/services/onesignal.service.ts|meta':
    'bare first arg ×4: { audience | storeId; notificationId; recipients: number; errors } — errors is the OneSignal response field (opaque provider body, Ruling LOG-PII-1)',
  'apps/api/src/middleware/request-transaction.ts|logContext':
    'Record<string, unknown>; its only caller (tenant-context.ts) passes { storeId, userId } / { userId, storeId, middleware }',
  'apps/api/src/routes/payment.routes.ts|rollbackContext': '{ orderId; storeId; sessionId } | null',
  'apps/api/src/services/ai.service.ts|ctx': '{ storeId: string; kind: string }',
  'apps/api/src/services/payment-providers/orphaned-invoice-alert.ts|o':
    'OrphanedProviderInvoice → storeId, orderId, orderNumber, provider, transactionId, amount, currency, source',
  'apps/api/src/services/payment-providers/unbooked-refund-alert.ts|a.context':
    'Record<string, unknown>; the four callers in payment.factory.ts pass payment / order / claim / refund ids and piastres amounts only',
  'packages/database/prisma/seed.ts|e':
    'bare first arg: `.catch(e => console.error(e))` — the Error from a local dev CLI, never deployed',
};

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name);
    if (statSync(p).isDirectory())
      return name === 'node_modules' || name === '__tests__' || name === '.next' ? [] : walk(p);
    return /\.tsx?$/.test(name) && !/\.(test|spec|d)\.tsx?$/.test(name) ? [p] : [];
  });
}

function unwrap(e: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isNonNullExpression(e) ||
    ts.isSatisfiesExpression(e) ||
    ts.isAwaitExpression(e)
  )
    e = e.expression;
  return e;
}

/** The trailing name of an expression: `user.email` → `email`, `to` → `to`. */
function leafName(e: ts.Expression): string | null {
  e = unwrap(e);
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  if (ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression))
    return e.argumentExpression.text;
  return null;
}

/** An interpolated / positional value: PII-shaped by its name alone. */
function piiNamed(e: ts.Expression): boolean {
  const leaf = leafName(e);
  return leaf !== null && (PII_LEAF.test(leaf) || PII_KEY.test(leaf));
}

export function scanLogCalls(
  source: string,
  file = 'input.ts'
): { violations: string[]; spreads: string[] } {
  const sf = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const violations: string[] = [];
  const spreads: string[] = [];
  const loggerAliases = new Set<string>();
  const levelFns = new Set<string>();

  const at = (n: ts.Node) => `${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;

  const isLoggerRef = (e: ts.Expression): boolean => {
    e = unwrap(e);
    if (ts.isIdentifier(e) && loggerAliases.has(e.text)) return true;
    if (
      ts.isPropertyAccessExpression(e) &&
      e.expression.kind === ts.SyntaxKind.ThisKeyword &&
      loggerAliases.has(e.name.text)
    )
      return true;
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression))
      return e.expression.name.text === 'child' && isLoggerRef(e.expression.expression);
    if (!ts.isIdentifier(e) && !ts.isPropertyAccessExpression(e)) return false;
    return RECEIVER.test(e.getText(sf));
  };

  /** `logger.warn`, `logger.warn.bind(logger)`, `logger[lvl]`, `a ? b : c`. */
  const isLevelFn = (e: ts.Expression): boolean => {
    e = unwrap(e);
    if (ts.isConditionalExpression(e)) return isLevelFn(e.whenTrue) || isLevelFn(e.whenFalse);
    if (ts.isIdentifier(e)) return levelFns.has(e.text);
    if (
      ts.isCallExpression(e) &&
      ts.isPropertyAccessExpression(e.expression) &&
      e.expression.name.text === 'bind'
    )
      return isLevelFn(e.expression.expression);
    if (ts.isPropertyAccessExpression(e))
      return LEVELS.has(e.name.text) && isLoggerRef(e.expression);
    if (ts.isElementAccessExpression(e)) return isLoggerRef(e.expression);
    return false;
  };

  const isLoggerValue = (e: ts.Expression): boolean => {
    e = unwrap(e);
    if (ts.isConditionalExpression(e))
      return isLoggerValue(e.whenTrue) || isLoggerValue(e.whenFalse);
    return isLoggerRef(e);
  };

  // Pass 1: aliases. Repeat to a fixpoint so `const a = logger; const b = a.child()` resolves.
  const collect = (n: ts.Node) => {
    if (
      (ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isPropertyDeclaration(n)) &&
      ts.isIdentifier(n.name)
    ) {
      const name = n.name.text;
      if (n.type && LOGGER_TYPE.test(n.type.getText(sf))) loggerAliases.add(name);
      if (n.initializer) {
        if (isLoggerValue(n.initializer)) loggerAliases.add(name);
        else if (isLevelFn(n.initializer)) levelFns.add(name);
      }
    }
    ts.forEachChild(n, collect);
  };
  let size = -1;
  while (size !== loggerAliases.size + levelFns.size) {
    size = loggerAliases.size + levelFns.size;
    collect(sf);
  }

  const flag = (n: ts.Node, what: string) => violations.push(`${at(n)} ${what}`);

  const isSafeValue = (e: ts.Expression): boolean => {
    e = unwrap(e);
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
      return e.templateSpans.every(s => !piiNamed(s.expression) || isSafeValue(s.expression));
    return false;
  };

  const checkObject = (obj: ts.ObjectLiteralExpression) => {
    for (const p of obj.properties) {
      if (ts.isSpreadAssignment(p)) {
        // An inline literal (`...(x ? { a } : {})`) is visible: check it.
        const branches = (e: ts.Expression): ts.Expression[] => {
          const u = unwrap(e);
          return ts.isConditionalExpression(u)
            ? [...branches(u.whenTrue), ...branches(u.whenFalse)]
            : [u];
        };
        const parts = branches(p.expression);
        if (parts.every(ts.isObjectLiteralExpression))
          parts.forEach(b => checkObject(b as ts.ObjectLiteralExpression));
        else spreads.push(`${file}|${p.expression.getText(sf)}`);
        continue;
      }
      let key: string;
      let value: ts.Expression;
      if (ts.isShorthandPropertyAssignment(p)) {
        key = p.name.text;
        value = p.name;
      } else if (ts.isPropertyAssignment(p)) {
        key = p.name.getText(sf).replace(/^['"`]|['"`]$/g, '');
        value = p.initializer;
      } else continue;
      if (ts.isObjectLiteralExpression(unwrap(value))) {
        checkObject(unwrap(value) as ts.ObjectLiteralExpression);
        continue;
      }
      // Issue 2396: `{ items: [{ email }] }` — an array under a non-contact key
      // is walked element by element, not dropped.
      if (!PII_KEY.test(key) && ts.isArrayLiteralExpression(unwrap(value))) {
        checkArray(unwrap(value) as ts.ArrayLiteralExpression);
        continue;
      }
      const leaf = leafName(value);
      const piiShaped = PII_KEY.test(key) || (leaf !== null && PII_LEAF.test(leaf));
      if (piiShaped && !isSafeValue(value)) flag(p, `${key}: ${value.getText(sf)}`);
      else if (!piiShaped) checkMessage(value);
    }
  };

  /** A message or a nested value: interpolations and concatenations. */
  const checkMessage = (e: ts.Expression) => {
    e = unwrap(e);
    if (ts.isTemplateExpression(e)) {
      for (const s of e.templateSpans)
        if (piiNamed(s.expression) && !isSafeValue(s.expression))
          flag(s.expression, `\${${s.expression.getText(sf)}}`);
    } else if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      for (const side of [e.left, e.right]) {
        const u = unwrap(side);
        if (ts.isBinaryExpression(u) || ts.isTemplateExpression(u)) checkMessage(u);
        else if (piiNamed(u) && !isSafeValue(u)) flag(u, `+ ${u.getText(sf)}`);
      }
    }
  };

  const checkArray = (arr: ts.ArrayLiteralExpression) => {
    for (const el of arr.elements) {
      if (ts.isSpreadElement(el)) spreads.push(`${file}|${el.expression.getText(sf)}`);
      else checkArg(el, 1);
    }
  };

  /**
   * `index` is the argument position. Argument 0 of a pino call IS the merge
   * object: `logger.info(scanResult, 'done')` writes every own key of
   * `scanResult` to the drain exactly as `{ ...scanResult }` does (issue 2396),
   * and `console.*` prints it whole. So an opaque first argument (a name, a
   * member, a call) is held to the spread rule: listed in REVIEWED_SPREADS or
   * the gate fails. Later positional arguments are format values, not merged.
   */
  const checkArg = (a: ts.Expression, index: number) => {
    const u = unwrap(a);
    if (ts.isObjectLiteralExpression(u)) checkObject(u);
    else if (ts.isArrayLiteralExpression(u)) checkArray(u);
    else if (ts.isTemplateExpression(u) || ts.isBinaryExpression(u)) checkMessage(u);
    else if (piiNamed(u) && !isSafeValue(u)) flag(u, u.getText(sf));
    else if (
      index === 0 &&
      !isSafeValue(u) &&
      (ts.isIdentifier(u) ||
        ts.isPropertyAccessExpression(u) ||
        ts.isElementAccessExpression(u) ||
        ts.isCallExpression(u))
    )
      spreads.push(`${file}|${u.getText(sf)}`);
  };

  const isLogCall = (n: ts.CallExpression): boolean => {
    const callee = unwrap(n.expression);
    if (ts.isIdentifier(callee)) return levelFns.has(callee.text);
    if (ts.isPropertyAccessExpression(callee))
      return (
        (LEVELS.has(callee.name.text) || callee.name.text === 'child') &&
        isLoggerRef(callee.expression)
      );
    if (ts.isElementAccessExpression(callee)) return isLoggerRef(callee.expression);
    return false;
  };

  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && isLogCall(n)) n.arguments.forEach((a, i) => checkArg(a, i));
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { violations, spreads };
}

export function findRawPiiLogFields(source: string, file = 'input.ts'): string[] {
  const { violations, spreads } = scanLogCalls(source, file);
  return [...violations, ...spreads.map(s => `unreviewed spread ${s}`)];
}

describe('no raw email / phone in any log call (issues 2390, 2392, 2394, 2396)', () => {
  const files = ROOTS.flatMap(r => walk(join(REPO, r)));
  const results = files.map(f => scanLogCalls(readFileSync(f, 'utf8'), relative(REPO, f)));

  it('walks every app and package tree', () => {
    // Positive control: each root that exists contributed files.
    for (const r of ['apps/api/src', 'apps/web/src', 'apps/orders/src', 'apps/admin/src'])
      expect(
        files.some(f => relative(REPO, f).startsWith(r)),
        r
      ).toBe(true);
    expect(files.length).toBeGreaterThan(900);
  });

  it('every log field / message carrying an email or phone is masked', () => {
    expect(results.flatMap(r => r.violations)).toEqual([]);
  });

  it('every spread inside a log object has been reviewed', () => {
    const seen = new Set(results.flatMap(r => r.spreads));
    expect(
      [...seen].filter(s => !(s in REVIEWED_SPREADS)),
      'unreviewed'
    ).toEqual([]);
    expect(
      Object.keys(REVIEWED_SPREADS).filter(s => !seen.has(s)),
      'stale REVIEWED_SPREADS entries'
    ).toEqual([]);
  });

  // Positive controls: the scanner must actually flag the shapes the issues name.
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
    // issue 2392: a spread is unreviewed until listed
    [`logger.info({ storeId, ...scanResult, emailed }, 'done')`],
    // issue 2394: bound / aliased / child / request-scoped loggers
    [`const logFn = ok ? logger.info.bind(logger) : logger.warn.bind(logger); logFn({ to }, 'x')`],
    [
      `const log = dead ? logger.error.bind(logger) : logger.warn.bind(logger); log({ to: c.email })`,
    ],
    [`const warn = logger.warn; warn({ email })`],
    [`const l = logger.child({ storeId }); l.info({ email }, 'x')`],
    [`const a = logger; const b = a.child({}); b.warn({ phone }, 'x')`],
    [`function f(l: Logger) { l.info({ email }, 'x') }`],
    [
      `class S { constructor(private readonly jobs: pino.Logger) {} m() { this.jobs.info({ phone }) } }`,
    ],
    [`req.log.info({ email: req.body.email }, 'x')`],
    [`logger[level]({ to }, 'x')`],
    [`logger.child({ customerEmail })`],
    // issue 2394: interpolated / concatenated messages and positional values
    [`logger.info(\`sent to \${email}\`)`],
    [`logger.info({ orderId }, \`receipt to \${order.customerEmail}\`)`],
    [`console.log('[otp] sent to ' + phone)`],
    [`console.warn('x', user.email)`],
    [`logger.info({ msg: \`to \${to}\` })`],
    [`logger.info({ id, ...(dup ? { email } : {}) }, 'x')`],
    // issue 2396: a bare merge object is as opaque as a spread; arrays are walked
    [`logger.info(scanResult, 'done')`],
    [`logger.warn(job.data, 'x')`],
    [`logger.info(buildMeta(order), 'x')`],
    [`console.error(e)`],
    [`logger.info({ items: [{ email }] }, 'x')`],
    [`logger.info({ items: [{ id }, user.phone] }, 'x')`],
    [`logger.info({ items: [...list] }, 'x')`],
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
    [`const fmt = logger.info; other({ email })`],
    [`logger.info(\`sent to \${maskEmail(email)}\`)`],
    [`logger.info(\`sent \${count} emails\`)`],
    [`console.log('sent ' + n + ' emails')`],
    [`const logFn = logger.info.bind(logger); logFn({ storeId }, 'request')`],
    [`toast.error(\`\${email} is taken\`)`],
    [`logger.info({ id, ...(dup ? { spent: n } : {}) }, 'x')`],
    // issue 2396: only argument 0 is merged; later ones are format values
    [`logger.info({ storeId }, message)`],
    [`logger.info(maskEmail(email))`],
    [`logger.info({ items: [{ id }, 3] }, 'x')`],
  ])('passes %s', src => {
    expect(findRawPiiLogFields(src)).toEqual([]);
  });
});
