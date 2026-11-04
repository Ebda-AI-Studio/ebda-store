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
import { isAbsolute, join, relative, sep } from 'node:path';
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

/**
 * Directory classification uses the path RELATIVE to the repo root: a checkout or worktree directory named
 * `...templates` / `...hooks` must not turn every file into a render-path file.
 */
export function repoRelative(file: string, root: string = ROOT): string {
  return isAbsolute(file) ? relative(root, file) : file;
}

/**
 * Plain `.ts` modules under `templates/` are helpers the skins' components call during render
 * (resolveBottomBar read the clock this way, FU46 final review I-1), so a clock read ANYWHERE in
 * one is render path: the scanner cannot follow the call, the file location stands for it.
 */
const isTemplateHelper = (file: string) =>
  /(^|[\\/])templates[\\/]/.test(repoRelative(file)) && /\.ts$/.test(file);

function isRenderPath(node: ts.Node, helperFile = false): boolean {
  if (helperFile) return true;
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
    /(^|[\\/])(components|templates|hooks|contexts)[\\/]/.test(repoRelative(file));
  if (!clientFile) return [];
  const helperFile = isTemplateHelper(file);
  const hits: string[] = [];
  const at = (n: ts.Node, what: string) => {
    const { line } = sf.getLineAndCharacterOfPosition(n.getStart());
    hits.push(`${file}:${line + 1} ${what}`);
  };
  const visit = (n: ts.Node) => {
    // location.href / window.location.origin ... : a property read ON the location object.
    if (
      ts.isPropertyAccessExpression(n) &&
      isLocationRoot(n.expression) &&
      isRenderPath(n, helperFile)
    ) {
      at(n, `render-time ${n.getText(sf)}`);
    }
    if (
      ts.isNewExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === 'Date' &&
      (n.arguments?.length ?? 0) === 0 &&
      isRenderPath(n, helperFile)
    ) {
      at(n, 'render-time new Date()');
    }
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      ts.isIdentifier(n.expression.expression) &&
      n.expression.expression.text === 'Date' &&
      n.expression.name.text === 'now' &&
      isRenderPath(n, helperFile)
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
 * (so no server HTML or hydrating render ever reaches them). Each names the gate and the exact
 * source text of its ONE hit: an entry explains a hit only when the file, the kind AND the
 * snippet on that line all match, and it must match exactly one hit. So a second render-time read
 * of the same kind added to an allowlisted file is reported, not masked by the first one's entry,
 * and an entry that stops matching fails the test, so this list cannot rot into a blanket
 * exemption.
 */
type Gated = { file: string; what: string; snippet: string; why: string };
const GATED: Gated[] = [
  {
    file: 'apps/admin/src/app/billing-events/_components/ManualPaymentForm.tsx',
    what: 'render-time new Date()',
    snippet: 'const today = dayString(new Date());',
    why: 'modal mounted by a click (`form &&` in billing-events/page.tsx)',
  },
  {
    file: 'apps/admin/src/app/billing-events/_components/ManualRefundForm.tsx',
    what: 'render-time new Date()',
    snippet: 'useState(dayString(new Date()))',
    why: 'modal mounted by a click (`refundTarget &&` in billing-events/page.tsx)',
  },
  {
    file: 'apps/admin/src/app/stores/[id]/billing/page.tsx',
    what: 'render-time new Date()',
    snippet: 'const currentMonth = new Date().toISOString().slice(0, 7);',
    why: 'only read against `data`, which is fetched after mount (undefined on the hydrating render)',
  },
  {
    file: 'apps/admin/src/app/stores/[id]/orders/[orderId]/_components/PaymentCard.tsx',
    what: 'render-time Date.now()',
    snippet: 'expiresAt.getTime() <= Date.now()',
    why: 'rendered only once the order is fetched client-side (page state starts null)',
  },
  {
    file: 'apps/admin/src/components/billing/UpsellDialog.tsx',
    what: 'render-time window.location.pathname',
    snippet: 'billingHref(window.location.pathname,',
    why: '`if (!event) return null` above it; the event arrives after mount',
  },
  {
    file: 'apps/marketing/src/components/Product3D.tsx',
    what: 'render-time window.location.href',
    snippet: "fallbackUrl: window.location.href.split('#')[0],",
    why: 'inside `showViewer`, which needs the `live` state set in an effect',
  },
];

/** A hit is `<file>:<line> <what>`; `lineText` is that source line. */
type Hit = { hit: string; lineText: string };
const explains = (g: Gated, h: Hit) =>
  h.hit.startsWith(g.file + ':') && h.hit.endsWith(g.what) && h.lineText.includes(g.snippet);

/** Hits no entry explains, plus entries that do not explain exactly one hit. */
export function auditGated(hits: Hit[], gated: Gated[]) {
  return {
    unexplained: hits.filter(h => !gated.some(g => explains(g, h))).map(h => h.hit),
    badEntries: gated
      .map(g => ({ file: g.file, snippet: g.snippet, n: hits.filter(h => explains(g, h)).length }))
      .filter(e => e.n !== 1),
  };
}

describe('no render-time window.location / Date in any Next app (B0-46)', () => {
  it('web, admin, orders and marketing render paths are clean', () => {
    const hits: Hit[] = ['web', 'admin', 'orders', 'marketing'].flatMap(app =>
      sourceFiles(join(ROOT, 'apps', app)).flatMap(f => {
        const text = readFileSync(f, 'utf8');
        const lines = text.split('\n');
        return scanSource(relative(ROOT, f), text).map(hit => ({
          hit,
          lineText: lines[Number(/:(\d+) /.exec(hit)![1]) - 1] ?? '',
        }));
      })
    );
    const { unexplained, badEntries } = auditGated(hits, GATED);
    expect(unexplained).toEqual([]);
    // every allowlist entry explains exactly one real hit
    expect(badEntries).toEqual([]);
  });

  it('a second hit of the same kind in an allowlisted file is NOT masked by the first entry', () => {
    const g = GATED[0];
    const first = { hit: `${g.file}:68 ${g.what}`, lineText: `  ${g.snippet}` };
    const second = { hit: `${g.file}:90 ${g.what}`, lineText: '  const later = new Date();' };
    expect(auditGated([first], [g])).toEqual({ unexplained: [], badEntries: [] });
    expect(auditGated([first, second], [g]).unexplained).toEqual([second.hit]);
    // the same snippet twice (copy-pasted line) is two hits for one entry: refused too
    const copy = { ...first, hit: `${g.file}:70 ${g.what}` };
    expect(auditGated([first, copy], [g]).badEntries).toEqual([
      { file: g.file, snippet: g.snippet, n: 2 },
    ]);
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
    it('catches a clock read inside a helper module under templates/ (FU46 I-1)', () => {
      const src = `export function resolveBottomBar() { const y = new Date().getFullYear(); return y; }`;
      expect(scanSource('apps/web/src/templates/shared/display-helpers.ts', src)).toHaveLength(1);
      expect(
        scanSource('apps/web/src/templates/shared/h.ts', `export const n = () => Date.now();`)
      ).toHaveLength(1);
      // a dated argument, or a helper outside templates/, stays alone
      expect(
        scanSource('apps/web/src/templates/shared/h.ts', `export const n = (a) => new Date(a);`)
      ).toEqual([]);
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

describe('directory classification is repo-relative', () => {
  it('a repo root named like a client directory does not make every file a client/render file', () => {
    const root = join(sep, 'w', 'ebda-store__fix-templates-hooks');
    const file = join(root, 'apps', 'api', 'src', 'lib', 'clock.ts');
    expect(repoRelative(file, root)).toBe(join('apps', 'api', 'src', 'lib', 'clock.ts'));
    expect(scanSource(file, 'export const t = () => Date.now();')).toEqual([]);
  });
});
