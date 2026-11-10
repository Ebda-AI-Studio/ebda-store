/**
 * Plan "Bug 10: placeholder copy gets published" — every bulk AI sweep
 * (store FAQ, store HowTo, meta-AEO x3, llms.txt, citation-copy, product
 * FAQ) writes Gemini's output DIRECTLY to a live, store-facing
 * column/table and busts the public cache in the same step. There is no
 * merchant draft/review gate on this path (unlike the single-item "Draft
 * with AI" routes, which return the suggestion to the admin UI for the
 * merchant to accept or edit first).
 *
 * Before this fix, the only check guarding every one of those writes was
 * "non-empty after .trim()" — a degenerate Gemini response like "N/A",
 * "TBD", "..." or "[insert text here]" trivially satisfies that and would
 * have gone live on the storefront with zero human review. `isPlaceholder`
 * (`lib/ai/eval/helpers.ts`, re-exporting `lib/ai/placeholder-guard.ts`)
 * already existed and already recognizes exactly this content — but it was
 * wired into the OFFLINE AI-output eval harness only
 * (`lib/ai/eval/criteria.ts`), never into any live write path.
 *
 * bulk-ai-product-faqs is driven end-to-end (its handler is captured and run
 * against fakes; what it WRITES is observed). The two large aeo/geo files
 * (1.3k + 0.9k lines, many DB shapes per sweep) would need a bespoke rig per
 * sweep, so their write sites are checked STRUCTURALLY on the parsed AST: the
 * write call must be control-dependent on the guard (inside the `if` whose
 * condition has `!isPlaceholderText(...)`, or after an earlier
 * `if (isPlaceholderText(...)) { continue|return|... }`). That replaces the old
 * text-position check, which a comment, an unrelated guard or a dead branch
 * could satisfy.
 *
 * Mutation-proof: removing the `isPlaceholderText(...)` guard from any one
 * write site below reddens that site's assertion.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { isPlaceholderText } from '../../apps/api/src/lib/ai/placeholder-guard';

// ── harness: run the REAL bulk-ai-product-faqs Inngest handler ─────────────
// `inngest.createFunction` is captured so the handler can be invoked with a
// pass-through `step`; the DB, Gemini generator, quota and cache layers are
// fakes. What is observed is what the sweep WRITES (productFaq.createMany).
const faqs = vi.hoisted(() => {
  process.env.AI_BULK_THROTTLE_MS = '0';
  return {
    handler: null as null | ((ctx: unknown) => Promise<unknown>),
    createMany: vi.fn(),
    generate: vi.fn(),
  };
});
vi.mock('@api/lib/inngest/client', () => ({
  inngest: {
    createFunction: (_opts: unknown, handler: (ctx: unknown) => Promise<unknown>) => {
      faqs.handler = handler;
      return {};
    },
  },
}));
vi.mock('@ebda/database', () => ({
  runInStoreScope: (_storeId: string, fn: () => unknown) => fn(),
}));
vi.mock('@api/config', () => ({ config: { googleAiKey: 'test-key' } }));
vi.mock('@api/lib/ai-quota', () => ({
  assertAiQuota: vi.fn().mockResolvedValue(undefined),
  isAiQuotaCapError: () => false,
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@api/lib/public-cache', () => ({
  invalidateStoreProductCaches: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@api/lib/ai/product-faq-generator', () => ({
  generateProductFaqs: (...a: unknown[]) => faqs.generate(...a),
}));
vi.mock('@api/lib/inngest/ai-retry', () => ({
  callWithRetry: (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@api/lib/repo-factory', () => ({
  storeWriter: async () => ({
    $transaction: async (ops: unknown[]) => ops,
    productFaq: { createMany: faqs.createMany, deleteMany: vi.fn() },
  }),
}));
vi.mock('@api/lib/jobs/store-db', () => ({
  lazyStoreDb: () => ({
    store: { findUnique: async () => ({ name: 'Shop' }) },
    bulkAiJob: { findUnique: async () => ({ status: 'running' }) },
    product: {
      findMany: async () => [
        {
          id: 'p1',
          name: 'Ring',
          nameAr: null,
          description: 'd',
          options: [],
          _count: { faqs: 0 },
        },
      ],
    },
  }),
  lazyStoreWriter: () => ({ bulkAiJob: { update: vi.fn().mockResolvedValue({}) } }),
}));

const AEO_PATH = join(__dirname, '../../apps/api/src/lib/inngest/functions/bulk-ai-aeo.ts');
const GEO_PATH = join(__dirname, '../../apps/api/src/lib/inngest/functions/bulk-ai-geo.ts');
const PRODUCT_FAQS_PATH = join(
  __dirname,
  '../../apps/api/src/lib/inngest/functions/bulk-ai-product-faqs.ts'
);

// ── AST helpers (aeo/geo write sites) ──────────────────────────────────────
const parseTs = (file: string) =>
  ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);

function walk(node: ts.Node, visit: (n: ts.Node) => void) {
  visit(node);
  node.forEachChild(c => walk(c, visit));
}

/** The Inngest function declared with `id: '<functionId>'` (its createFunction call). */
function functionNode(sf: ts.SourceFile, functionId: string): ts.CallExpression {
  let found: ts.CallExpression | undefined;
  walk(sf, n => {
    if (!ts.isCallExpression(n) || !n.expression.getText().endsWith('createFunction')) return;
    const opts = n.arguments[0];
    if (!opts || !ts.isObjectLiteralExpression(opts)) return;
    const id = opts.properties.find(
      (pr): pr is ts.PropertyAssignment => ts.isPropertyAssignment(pr) && pr.name.getText() === 'id'
    );
    if (id && ts.isStringLiteralLike(id.initializer) && id.initializer.text === functionId)
      found = n;
  });
  expect(found, `could not find createFunction id '${functionId}'`).toBeDefined();
  return found!;
}

/** Calls whose callee text matches `callee` (a write such as `sw.storeFaq.create`). */
function callsTo(root: ts.Node, callee: string): ts.CallExpression[] {
  const out: ts.CallExpression[] = [];
  walk(root, n => {
    if (ts.isCallExpression(n) && n.expression.getText() === callee) out.push(n);
  });
  return out;
}

/** Calls that pass an object literal with `data: { <key>: ... }` (a Prisma write of that column). */
function writesOfColumn(root: ts.Node, key: string): ts.CallExpression[] {
  const out: ts.CallExpression[] = [];
  walk(root, n => {
    if (!ts.isCallExpression(n)) return;
    const hit = n.arguments.some(
      a =>
        ts.isObjectLiteralExpression(a) &&
        a.properties.some(
          pr =>
            ts.isPropertyAssignment(pr) &&
            pr.name.getText() === 'data' &&
            ts.isObjectLiteralExpression(pr.initializer) &&
            pr.initializer.properties.some(dp => dp.name?.getText() === key)
        )
    );
    if (hit) out.push(n);
  });
  return out;
}

const unparen = (e: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(e) ? unparen(e.expression) : e;
function operands(e: ts.Expression, op: ts.SyntaxKind): ts.Expression[] {
  const x = unparen(e);
  return ts.isBinaryExpression(x) && x.operatorToken.kind === op
    ? [...operands(x.left, op), ...operands(x.right, op)]
    : [x];
}
const isGuardCall = (e: ts.Expression) =>
  ts.isCallExpression(e) && e.expression.getText() === 'isPlaceholderText';
/** `a && !isPlaceholderText(x)`: passes only when the text is real. */
const passesOnlyIfReal = (cond: ts.Expression) =>
  operands(cond, ts.SyntaxKind.AmpersandAmpersandToken).some(
    o =>
      ts.isPrefixUnaryExpression(o) &&
      o.operator === ts.SyntaxKind.ExclamationToken &&
      isGuardCall(unparen(o.operand))
  );
/** `isPlaceholderText(x) || ...`: true when the text is a placeholder. */
const rejectsPlaceholder = (cond: ts.Expression) =>
  operands(cond, ts.SyntaxKind.BarBarToken).some(isGuardCall);
const exits = (st: ts.Statement): boolean => {
  const last = ts.isBlock(st) ? st.statements[st.statements.length - 1] : st;
  return (
    !!last &&
    (ts.isContinueStatement(last) ||
      ts.isReturnStatement(last) ||
      ts.isThrowStatement(last) ||
      ts.isBreakStatement(last))
  );
};

/** Whether `node` only runs when the placeholder guard let the text through. */
function isGuarded(node: ts.Node): boolean {
  for (let cur: ts.Node = node; cur.parent; cur = cur.parent) {
    const p = cur.parent;
    if (ts.isIfStatement(p) && p.thenStatement === cur && passesOnlyIfReal(p.expression))
      return true;
    if (ts.isBlock(p) || ts.isCaseClause(p) || ts.isDefaultClause(p)) {
      const stmts = p.statements;
      const at = stmts.indexOf(cur as ts.Statement);
      if (
        stmts
          .slice(0, Math.max(at, 0))
          .some(
            st =>
              ts.isIfStatement(st) && rejectsPlaceholder(st.expression) && exits(st.thenStatement)
          )
      )
        return true;
    }
  }
  return false;
}

function expectGuardedWrites(writes: ts.CallExpression[], count: number, what: string) {
  expect(writes, `expected ${count} ${what} write site(s)`).toHaveLength(count);
  for (const w of writes)
    expect(isGuarded(w), `${what} is not behind isPlaceholderText`).toBe(true);
}

describe('isPlaceholderText (shared guard)', () => {
  it('flags degenerate Gemini output a bulk sweep must not publish', () => {
    expect(isPlaceholderText('N/A')).toBe(true);
    expect(isPlaceholderText('TBD')).toBe(true);
    expect(isPlaceholderText('...')).toBe(true);
    expect(isPlaceholderText('[insert text here]')).toBe(true);
    expect(isPlaceholderText('')).toBe(true);
    expect(isPlaceholderText('   ')).toBe(true);
  });

  it('passes genuine generated content', () => {
    expect(isPlaceholderText('Delivery takes 2-4 business days across Cairo and Giza.')).toBe(
      false
    );
  });
});

describe('bulk-ai-aeo.ts: every live write site rejects placeholder output before it reaches the store', () => {
  const source = readFileSync(AEO_PATH, 'utf8');

  it('imports the shared guard', () => {
    expect(source).toContain("from '../../ai/placeholder-guard'");
  });

  const sf = parseTs(AEO_PATH);

  it('bulk-ai-faq-aeo guards StoreFaq.create (question + answer)', () => {
    const fn = functionNode(sf, 'bulk-ai-faq-aeo');
    expectGuardedWrites(callsTo(fn, 'sw.storeFaq.create'), 1, 'storeFaq.create');
  });

  it('bulk-ai-howto-aeo guards StoreHowto.create (title + description)', () => {
    const fn = functionNode(sf, 'bulk-ai-howto-aeo');
    expectGuardedWrites(callsTo(fn, 'sw.storeHowto.create'), 1, 'storeHowto.create');
  });

  it('bulk-ai-meta-aeo guards the store/product/category metaDescriptionAeo writes', () => {
    const fn = functionNode(sf, 'bulk-ai-meta-aeo');
    // Three write sites (store, product, category), each behind its own guard.
    expectGuardedWrites(writesOfColumn(fn, 'metaDescriptionAeo'), 3, 'metaDescriptionAeo');
  });
});

describe('bulk-ai-geo.ts: every live write site rejects placeholder output before it reaches the store', () => {
  const source = readFileSync(GEO_PATH, 'utf8');

  it('imports the shared guard', () => {
    expect(source).toContain("from '../../ai/placeholder-guard'");
  });

  const sf = parseTs(GEO_PATH);

  it('bulk-ai-llms-txt guards Store.llmsTxt', () => {
    const fn = functionNode(sf, 'bulk-ai-llms-txt');
    expectGuardedWrites(writesOfColumn(fn, 'llmsTxt'), 1, 'Store.llmsTxt');
  });

  it('bulk-ai-citation-copy guards Product.citationCopy', () => {
    const fn = functionNode(sf, 'bulk-ai-citation-copy');
    expectGuardedWrites(writesOfColumn(fn, 'citationCopy'), 1, 'Product.citationCopy');
  });
});

describe('bulk-ai-product-faqs.ts: the catalogue-wide product FAQ sweep rejects placeholder output', () => {
  const source = readFileSync(PRODUCT_FAQS_PATH, 'utf8');

  it('imports the shared guard', () => {
    expect(source).toContain("from '../../ai/placeholder-guard'");
  });

  const runSweep = async (generated: unknown[]) => {
    faqs.generate.mockResolvedValue(generated);
    await import('@api/lib/inngest/functions/bulk-ai-product-faqs');
    const step = { run: async (_name: string, fn: () => unknown) => fn() };
    await faqs.handler!({
      event: { data: { jobId: 'job-1', storeId: 'store-1', force: false } },
      step,
    });
  };

  beforeEach(() => vi.clearAllMocks());

  const good = {
    question: 'How long does delivery take?',
    questionAr: 'q',
    answer: 'Delivery takes 2-4 business days across Cairo and Giza.',
    answerAr: 'a',
  };

  it('guards productFaq.createMany (question + answer per FAQ)', async () => {
    await runSweep([
      good,
      { ...good, question: 'N/A' }, // placeholder question
      { ...good, answer: 'TBD' }, // placeholder answer
      { ...good, question: '[insert text here]' },
    ]);
    expect(faqs.createMany).toHaveBeenCalledTimes(1);
    const rows = faqs.createMany.mock.calls[0][0].data as { question: string; answer: string }[];
    expect(rows.map(r => r.question)).toEqual([good.question]);
  });

  it('writes nothing when every generated FAQ is a placeholder', async () => {
    await runSweep([
      { ...good, question: 'N/A' },
      { ...good, answer: '...' },
    ]);
    expect(faqs.createMany).not.toHaveBeenCalled();
  });
});
