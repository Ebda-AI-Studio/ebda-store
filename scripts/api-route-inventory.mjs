#!/usr/bin/env node
/**
 * BE:F-9 - static inventory of every Express route in apps/api/src/routes.
 *
 *   node scripts/api-route-inventory.mjs           write docs/api/route-inventory.md
 *   node scripts/api-route-inventory.mjs --check   exit 1 when the committed doc is stale (not wired into CI)
 *
 * Purely static (TypeScript AST, nothing is executed): for each `<router>.get|post|put|patch|delete|all(path, ...mw, handler)`
 * it records the method, the path joined with every mount prefix found in routes/*.ts and app.ts, the middleware chain
 * (file-level `router.use(mw)` before the route and mount-level middleware included), and splits out requireFeature /
 * requirePermission. Limits: paths built from non-constant expressions are shown as `<dynamic>`; middleware that is applied
 * in a way the AST cannot see (router.param, a wrapper that registers routes) is not listed.
 * "Callers" is a heuristic: a route counts as called when some string literal in apps/admin/src or apps/web/src, with
 * `${...}` read as a parameter and the query string dropped, equals the route path (after `/api/v1`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'apps/api/src');
const ROUTES = path.join(SRC, 'routes');
const OUT = path.join(ROOT, 'docs/api/route-inventory.md');
const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'all']);

const rel = f => path.relative(ROOT, f).split(path.sep).join('/');
const walk = (dir, pred, acc = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '__tests__') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, pred, acc);
    else if (pred(p)) acc.push(p);
  }
  return acc;
};
const parse = f =>
  ts.createSourceFile(
    f,
    fs.readFileSync(f, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    f.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );

/** Resolve an import specifier relative to `from` to a .ts file (or null for packages). */
function resolveModule(from, spec) {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(from), spec);
  for (const c of [base + '.ts', path.join(base, 'index.ts'), base])
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  return null;
}

const isRouterInit = n =>
  n && ts.isCallExpression(n) && /(^|\.)Router$/.test(n.expression.getText());

/** Per-file facts: router vars, string consts, array consts, imports, exports. */
function analyse(file) {
  const sf = parse(file);
  const info = {
    file,
    sf,
    routers: new Set(),
    strings: new Map(),
    arrays: new Map(),
    imports: new Map(),
    exports: new Map(),
  };
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && st.importClause) {
      const target = resolveModule(file, st.moduleSpecifier.text);
      if (!target) continue;
      const ic = st.importClause;
      if (ic.name) info.imports.set(ic.name.text, { target, name: 'default' });
      if (ic.namedBindings && ts.isNamedImports(ic.namedBindings))
        for (const el of ic.namedBindings.elements)
          info.imports.set(el.name.text, { target, name: (el.propertyName ?? el.name).text });
    }
    if (ts.isVariableStatement(st)) {
      const exported = st.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) continue;
        const n = d.name.text;
        if (isRouterInit(d.initializer)) info.routers.add(n);
        else if (d.initializer && ts.isStringLiteralLike(d.initializer))
          info.strings.set(n, d.initializer.text);
        else if (d.initializer && ts.isArrayLiteralExpression(d.initializer))
          info.arrays.set(n, d.initializer.elements);
        if (exported) info.exports.set(n, n);
      }
    }
    if (ts.isExportAssignment(st) && ts.isIdentifier(st.expression))
      info.exports.set('default', st.expression.text);
    if (
      ts.isExportDeclaration(st) &&
      st.exportClause &&
      ts.isNamedExports(st.exportClause) &&
      !st.moduleSpecifier
    )
      for (const el of st.exportClause.elements)
        info.exports.set(el.name.text, (el.propertyName ?? el.name).text);
  }
  return info;
}

const files = [
  ...walk(ROUTES, p => p.endsWith('.ts') && !p.endsWith('.test.ts')),
  path.join(SRC, 'app.ts'),
];
const infos = new Map(files.map(f => [f, analyse(f)]));

/** Router key for an identifier used in `info.file`: local router var, or an imported router. */
function routerKey(info, ident) {
  if (info.routers.has(ident)) return `${info.file}#${ident}`;
  const imp = info.imports.get(ident);
  const target = imp && infos.get(imp.target);
  if (target) {
    const local = target.exports.get(imp.name);
    if (local && target.routers.has(local)) return `${target.file}#${local}`;
  }
  return null;
}

const constString = (info, n) => {
  if (ts.isStringLiteralLike(n)) return n.text;
  if (ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  if (ts.isTemplateExpression(n))
    return (
      n.head.text +
      n.templateSpans
        .map(s => `:${s.expression.getText().replace(/\W+/g, '_')}` + s.literal.text)
        .join('')
    );
  if (ts.isIdentifier(n) && info.strings.has(n.text)) return info.strings.get(n.text);
  if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const a = constString(info, n.left),
      b = constString(info, n.right);
    return a != null && b != null ? a + b : null;
  }
  return null;
};

/** Flatten middleware args: spreads of const arrays are expanded; each item reduced to a short label. */
function mwList(info, args) {
  const out = [];
  for (const a of args) {
    if (
      ts.isSpreadElement(a) &&
      ts.isIdentifier(a.expression) &&
      info.arrays.has(a.expression.text)
    )
      out.push(...mwList(info, info.arrays.get(a.expression.text)));
    else if (ts.isSpreadElement(a)) out.push({ label: `...${a.expression.getText()}` });
    else if (ts.isArrayLiteralExpression(a)) out.push(...mwList(info, a.elements));
    else if (ts.isArrowFunction(a) || ts.isFunctionExpression(a))
      out.push({ label: '(inline)', inline: true });
    else if (ts.isCallExpression(a))
      out.push({
        label: a.getText().replace(/\s+/g, ' ').slice(0, 90),
        name: a.expression.getText(),
      });
    else out.push({ label: a.getText().replace(/\s+/g, ' ').slice(0, 90), name: a.getText() });
  }
  return out;
}

const routes = []; // {key, method, path, mw, file, line}
const edges = []; // {parent, child, prefix, mw}
const fileMw = new Map(); // key -> [{pos, mw}]
for (const info of infos.values()) {
  const visit = n => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      ts.isIdentifier(n.expression.expression)
    ) {
      const recv = n.expression.expression.text,
        m = n.expression.name.text;
      const parent =
        routerKey(info, recv) ??
        (info.file.endsWith('app.ts') && recv === 'app' ? `${info.file}#app` : null);
      if (parent && METHODS.has(m) && n.arguments.length >= 2 && !info.file.endsWith('app.ts')) {
        const p = constString(info, n.arguments[0]);
        const rest = n.arguments.slice(1);
        const mws = mwList(info, rest.slice(0, -1));
        const { line } = info.sf.getLineAndCharacterOfPosition(n.getStart());
        routes.push({
          key: parent,
          method: m.toUpperCase(),
          path: p ?? '<dynamic>',
          mw: mws,
          file: rel(info.file),
          line: line + 1,
          pos: n.getStart(),
        });
      } else if (parent && m === 'use' && n.arguments.length >= 1) {
        const args = [...n.arguments];
        let prefix = '';
        if (
          constString(info, args[0]) != null &&
          (ts.isStringLiteralLike(args[0]) ||
            ts.isTemplateExpression(args[0]) ||
            ts.isIdentifier(args[0]))
        )
          prefix = constString(info, args.shift());
        const last = args[args.length - 1];
        const child = last && ts.isIdentifier(last) ? routerKey(info, last.text) : null;
        if (child) edges.push({ parent, child, prefix, mw: mwList(info, args.slice(0, -1)) });
        else if (!info.file.endsWith('app.ts')) {
          const list = fileMw.get(parent) ?? [];
          list.push({ pos: n.getStart(), prefix, mw: mwList(info, args) });
          fileMw.set(parent, list);
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(info.sf);
}

// Roots: routes/index.ts router is mounted at /api/v1 in app.ts; app.ts mounts are not Router vars, handled below.
const indexKey = `${path.join(ROUTES, 'index.ts')}#router`;
const mountsOf = key => edges.filter(e => e.child === key);
function prefixesFor(key, seen = new Set()) {
  if (seen.has(key)) return [];
  if (key === indexKey) return [{ prefix: '/api/v1', mw: [] }];
  if (key.endsWith('app.ts#app')) return [{ prefix: '', mw: [] }];
  const ms = mountsOf(key);
  if (!ms.length) return [{ prefix: '', mw: [], unmounted: true }];
  const out = [];
  for (const e of ms)
    for (const up of prefixesFor(e.parent, new Set([...seen, key])))
      out.push({
        prefix: join(up.prefix, e.prefix),
        mw: [...up.mw, ...e.mw],
        unmounted: up.unmounted,
      });
  return out;
}
const join = (...parts) => ('/' + parts.join('/')).replace(/\/+/g, '/').replace(/(.)\/$/, '$1');

// Caller corpus (heuristic).
const lits = new Set();
const norm = s => {
  s = s.replace(/\$\{[^}]*\}/g, ':p').split(/[?#]/)[0];
  s = s.replace(/^\/api\/v1(?=\/)/, '');
  return s.replace(/\/+$/, '') || '/';
};
const litRe = /(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g;
for (const app of ['apps/admin/src', 'apps/web/src']) {
  const dir = path.join(ROOT, app);
  if (!fs.existsSync(dir)) continue;
  for (const f of walk(dir, p => /\.tsx?$/.test(p) && !/\.test\./.test(p))) {
    const text = fs.readFileSync(f, 'utf8');
    for (const m of text.matchAll(litRe)) if (m[2].startsWith('/')) lits.add(norm(m[2]));
  }
}
const normRoute = p =>
  p
    .replace(/^\/api\/v1(?=\/)/, '')
    .replace(/:[A-Za-z0-9_]+(\([^)]*\))?\??/g, ':p')
    .replace(/\/+$/, '') || '/';

const AUTH =
  /auth|authorize|requireStoreAccess|requireMfa|requireSuper|requireStaff|requireVerified|requireAgent|apiKey|requireOwner|requireImpersonat/i;
const rows = [];
for (const r of routes) {
  const own = (fileMw.get(r.key) ?? []).filter(f => f.pos < r.pos);
  for (const mount of prefixesFor(r.key)) {
    const fileLevel = own.flatMap(f => f.mw);
    const chain = [...mount.mw, ...fileLevel, ...r.mw].filter(x => !x.inline);
    const full = join(mount.prefix, r.path === '<dynamic>' ? '<dynamic>' : r.path);
    const feature = chain.filter(x => /^requireFeature\b/.test(x.name ?? '')).map(x => x.label);
    const perm = chain.filter(x => /^requirePermission\b/.test(x.name ?? '')).map(x => x.label);
    const rest = chain.filter(x => !/^require(Feature|Permission)\b/.test(x.name ?? ''));
    rows.push({
      method: r.method,
      path: full,
      auth: rest.filter(x => AUTH.test(x.name ?? x.label)).map(x => x.label),
      other: rest.filter(x => !AUTH.test(x.name ?? x.label)).map(x => x.label),
      feature,
      perm,
      src: `${r.file}:${r.line}`,
      called: lits.has(normRoute(full)),
      unmounted: !!mount.unmounted,
    });
  }
}
// app.ts mounts (webhooks etc.) are not Router chains: list the route files they mount by hand-free derivation.
rows.sort(
  (a, b) =>
    a.path.localeCompare(b.path) || a.method.localeCompare(b.method) || a.src.localeCompare(b.src)
);

const cell = a => (a.length ? a.map(x => '`' + x.replace(/\|/g, '\\|') + '`').join(', ') : '-');
const uncalled = rows.filter(r => !r.called).length;
const md = [
  '# API route inventory',
  '',
  'Generated by `node scripts/api-route-inventory.mjs` (static TypeScript AST scan of `apps/api/src/routes`). Do not edit by hand; run the script and commit the result. `node scripts/api-route-inventory.mjs --check` exits 1 when this file is stale.',
  '',
  '- Path = mount prefixes from `routes/index.ts` / nested `router.use` joined to the route path (`/api/v1` is the root mount). `<dynamic>` = path not a constant.',
  '- Auth = authentication / authorization / access middleware in order (mount-level, file-level `router.use`, then per-route). Other = remaining middleware (limiters, tenant context, validators).',
  '- Mounts are read from `router.use(prefix, ...mw, routerIdentifier)` in `routes/*.ts` and `app.ts` (the raw-body webhooks are mounted there). A router with no such mount is marked `(unmounted)` and shown with its own paths only.',
  '- Callers is a heuristic (a string literal in `apps/admin/src` or `apps/web/src` equals the path). `no` is a lead, not proof: callers that build the path from pieces, mobile apps, webhooks and third parties are not seen.',
  '',
  `Totals: ${rows.length} route registrations, ${uncalled} with no admin/web literal caller.`,
  '',
  '| Method | Path | Auth | requireFeature | requirePermission | Other middleware | Source | Caller |',
  '|---|---|---|---|---|---|---|---|',
  ...rows.map(
    r =>
      `| ${r.method} | \`${r.path}\`${r.unmounted ? ' (unmounted)' : ''} | ${cell(r.auth)} | ${cell(r.feature)} | ${cell(r.perm)} | ${cell(r.other)} | ${r.src} | ${r.called ? 'yes' : 'no'} |`
  ),
  '',
].join('\n');

const prettier = (() => {
  try {
    return require('prettier');
  } catch {
    return null;
  }
})();
const finalText = prettier
  ? await prettier.format(md, { parser: 'markdown', ...(await prettier.resolveConfig(OUT)) })
  : md;

if (process.argv.includes('--check')) {
  const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (cur !== finalText) {
    console.error(
      'docs/api/route-inventory.md is stale: run `node scripts/api-route-inventory.mjs` and commit.'
    );
    process.exit(1);
  }
  console.log(`route inventory up to date (${rows.length} routes)`);
} else {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, finalText);
  console.log(`wrote ${rel(OUT)}: ${rows.length} routes, ${uncalled} without a literal caller`);
}
