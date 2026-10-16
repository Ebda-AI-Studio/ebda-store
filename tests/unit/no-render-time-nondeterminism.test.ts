/**
 * B0-46 (ShareProductRow, flickering-footer year): a value that differs between the server
 * render and the client's hydrating render is a hydration mismatch. Two families are banned
 * from a component's / hook's RENDER path in every Next app (web, admin, orders, marketing):
 *
 *   1. `window.location.*` / `location.*` reads - '' (or throws) on the server, the real URL on
 *      the client, whatever `typeof window` ternary wraps it, in either order. Use
 *      `useCurrentUrl()` (apps/web/src/hooks) or pass the canonical URL down from server data.
 *   2. `new Date()` (no argument) and `Date.now()` - the server's clock is never the client's.
 *      Use the per-request `now` threaded from RootLayout (RenderClockContext) or an effect.
 *
 * "Render path" = code whose nearest enclosing function is a component or hook (capitalised or
 * `use*` name), looking through the initialisers React runs during render (`useMemo`,
 * `useState(() => ...)`, `useReducer`, `useRef` init). Effects, event handlers, callbacks, and
 * `useSyncExternalStore` subscribe/snapshot functions are NOT render path. Files that never ship
 * to the client (no 'use client' and not under components/, templates/, hooks/, contexts/) are
 * skipped: a server component renders once and nothing hydrates.
 *
 * `scanSource` is exported-in-spirit: the mutation cases below drive it directly.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const RENDER_INITIALISERS = new Set(['useMemo', 'useState', 'useReducer', 'useRef']);
const isComponentName = (n: string | undefined) =>
  !!n && (/^[A-Z]/.test(n) || /^use[A-Z0-9]/.test(n));

function fnName(fn: ts.Node): string | undefined {
  if ((ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn)) && fn.name) return fn.name.text;
  const p = fn.parent;
  if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
  if (p && ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) return p.name.text;
  // memo(function X) / forwardRef((props, ref) => ...) / export default function () {}
  if (
    p &&
    ts.isCallExpression(p) &&
    ts.isIdentifier(p.expression) &&
    /^(memo|forwardRef)$/.test(p.expression.text)
  ) {
    return fnName(p) ?? 'Anonymous';
  }
  if (
    p &&
    ts.isCallExpression(p) &&
    ts.isPropertyAccessExpression(p.expression) &&
    /^(memo|forwardRef)$/.test(p.expression.name.text)
  ) {
    return fnName(p) ?? 'Anonymous';
  }
  if (p && ts.isExportAssignment(p)) return 'Anonymous';
  if (
    ts.isFunctionDeclaration(fn) &&
    fn.modifiers?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword)
  )
    return 'Anonymous';
  return undefined;
}

function isRenderPath(node: ts.Node): boolean {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (
      ts.isFunctionLike(cur) &&
      !ts.isMethodDeclaration(cur) &&
      !ts.isConstructorDeclaration(cur)
    ) {
      const p = cur.parent;
      if (
        p &&
        ts.isCallExpression(p) &&
        ts.isIdentifier(p.expression) &&
        RENDER_INITIALISERS.has(p.expression.text) &&
        p.arguments[0] === cur
      ) {
        cur = p.parent;
        continue; // runs during render: judge the enclosing function instead
      }
      return isComponentName(fnName(cur));
    }
    cur = cur.parent;
  }
  return false;
}

const isLocationRoot = (e: ts.Expression): boolean =>
  (ts.isIdentifier(e) && e.text === 'location') ||
  (ts.isPropertyAccessExpression(e) &&
    ts.isIdentifier(e.expression) &&
    e.expression.text === 'window' &&
    e.name.text === 'location');

export function scanSource(file: string, text: string): string[] {
  const sf = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const clientFile =
    /^\s*(['"])use client\1/m.test(text.slice(0, 400)) ||
    /[\\/](components|templates|hooks|contexts)[\\/]/.test(file);
  if (!clientFile) return [];
  const hits: string[] = [];
  const at = (n: ts.Node, what: string) => {
    const { line } = sf.getLineAndCharacterOfPosition(n.getStart());
    hits.push(`${file}:${line + 1} ${what}`);
  };
  const visit = (n: ts.Node) => {
    // location.href / window.location.origin ... : a property read ON the location object.
    if (ts.isPropertyAccessExpression(n) && isLocationRoot(n.expression) && isRenderPath(n)) {
      at(n, `render-time ${n.getText(sf)}`);
    }
    if (
      ts.isNewExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === 'Date' &&
      (n.arguments?.length ?? 0) === 0 &&
      isRenderPath(n)
    ) {
      at(n, 'render-time new Date()');
    }
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      ts.isIdentifier(n.expression.expression) &&
      n.expression.expression.text === 'Date' &&
      n.expression.name.text === 'now' &&
      isRenderPath(n)
    ) {
      at(n, 'render-time Date.now()');
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return hits;
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name === '.open-next' || name === 'dist')
      continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.tsx?$/.test(p) && !/\.(test|spec|d)\.tsx?$/.test(p) && !/__tests__/.test(p))
      out.push(p);
  }
  return out;
}

const ROOT = join(__dirname, '../..');

/**
 * Hits the scanner cannot prove safe but that are gated on state that only exists after mount
 * (so no server HTML or hydrating render ever reaches them). Each names the gate; an entry
 * that stops matching fails the test, so this list cannot rot into a blanket exemption.
 */
const GATED: Array<{ file: string; what: string; why: string }> = [
  {
    file: 'apps/admin/src/app/billing-events/_components/ManualPaymentForm.tsx',
    what: 'render-time new Date()',
    why: 'modal mounted by a click (`form &&` in billing-events/page.tsx)',
  },
  {
    file: 'apps/admin/src/app/billing-events/_components/ManualRefundForm.tsx',
    what: 'render-time new Date()',
    why: 'modal mounted by a click (`refundTarget &&` in billing-events/page.tsx)',
  },
  {
    file: 'apps/admin/src/app/stores/[id]/billing/page.tsx',
    what: 'render-time new Date()',
    why: 'only read against `data`, which is fetched after mount (undefined on the hydrating render)',
  },
  {
    file: 'apps/admin/src/app/stores/[id]/orders/[orderId]/_components/PaymentCard.tsx',
    what: 'render-time Date.now()',
    why: 'rendered only once the order is fetched client-side (page state starts null)',
  },
  {
    file: 'apps/admin/src/components/billing/UpsellDialog.tsx',
    what: 'render-time window.location.pathname',
    why: '`if (!event) return null` above it; the event arrives after mount',
  },
  {
    file: 'apps/marketing/src/components/Product3D.tsx',
    what: 'render-time window.location.href',
    why: 'inside `showViewer`, which needs the `live` state set in an effect',
  },
];

describe('no render-time window.location / Date in any Next app (B0-46)', () => {
  it('web, admin, orders and marketing render paths are clean', () => {
    const hits = ['web', 'admin', 'orders', 'marketing'].flatMap(app =>
      sourceFiles(join(ROOT, 'apps', app)).flatMap(f =>
        scanSource(relative(ROOT, f), readFileSync(f, 'utf8'))
      )
    );
    const unexplained = hits.filter(
      h => !GATED.some(g => h.startsWith(g.file + ':') && h.endsWith(g.what))
    );
    expect(unexplained).toEqual([]);
    // every allowlist entry must still match a real hit
    for (const g of GATED)
      expect(
        hits.some(h => h.startsWith(g.file + ':') && h.endsWith(g.what)),
        g.file
      ).toBe(true);
  });

  describe('the scanner itself (mutations it must catch / cases it must leave alone)', () => {
    const wrap = (body: string) =>
      `'use client';\nexport function Thing() {\n${body}\nreturn null;\n}\n`;
    it.each([
      [
        'original guarded ternary',
        `const u = typeof window !== 'undefined' ? window.location.href : '';`,
      ],
      ['reversed ternary', `const u = typeof window === 'undefined' ? '' : window.location.href;`],
      ['origin ternary', `const o = typeof window !== 'undefined' ? window.location.origin : '';`],
      ['bare location read', `const p = location.pathname;`],
      ['new Date year at render', `const y = new Date().getFullYear();`],
      ['Date.now at render', `const t = Date.now();`],
      ['inside useMemo', `const t = useMemo(() => Date.now(), []);`],
      ['inside useState initialiser', `const [u] = useState(() => window.location.href);`],
    ])('catches: %s', (_n, body) => {
      expect(scanSource('x/Thing.tsx', wrap(body))).toHaveLength(1);
    });
    it.each([
      ['useEffect', `useEffect(() => { setU(window.location.href); }, []);`],
      [
        'event handler',
        `const onClick = () => { window.location.href = '/x'; const t = Date.now(); };`,
      ],
      ['useCallback', `const f = useCallback(() => new Date().getTime(), []);`],
      [
        'useSyncExternalStore snapshot',
        `const u = useSyncExternalStore(sub, () => window.location.href, () => '');`,
      ],
      ['dated with an argument', `const d = new Date(post.createdAt).getFullYear();`],
    ])('leaves alone: %s', (_n, body) => {
      expect(scanSource('x/Thing.tsx', wrap(body))).toEqual([]);
    });
    it('skips server-only files (no use client, not under components/templates/hooks/contexts)', () => {
      expect(
        scanSource(
          'app/x/page.tsx',
          `export default function P(){ const y = new Date().getFullYear(); return null; }`
        )
      ).toEqual([]);
    });
  });
});
