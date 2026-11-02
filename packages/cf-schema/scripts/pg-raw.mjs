// Reads the Postgres-only invariants that live in raw migration SQL (not in schema.prisma): named CHECK
// constraints and partial/expression-free indexes, replays CREATE/DROP in migration order, and
// translates the expressions to SQLite. An expression this file cannot translate THROWS, so a new
// Postgres-only construct fails the generator instead of being silently dropped.
import fs from 'node:fs';
import path from 'node:path';

function readStatements(sql) {
  // strip -- comments (outside quotes) and split on ; (outside quotes/parens/dollar blocks)
  const out = [];
  let cur = '';
  let inStr = false;
  let depth = 0;
  let dollar = null;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (dollar) {
      cur += c;
      if (sql.startsWith(dollar, i) && cur.length > dollar.length * 2) {
        cur += sql.slice(i + 1, i + dollar.length);
        i += dollar.length - 1;
        dollar = null;
      }
      continue;
    }
    if (!inStr && c === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      cur += '\n';
      continue;
    }
    if (c === "'") inStr = !inStr;
    if (!inStr && c === '$') {
      const m = sql.slice(i).match(/^\$[A-Za-z_]*\$/);
      if (m) {
        dollar = m[0];
        cur += m[0];
        i += m[0].length - 1;
        continue;
      }
    }
    if (!inStr) {
      if (c === '(') depth++;
      if (c === ')') depth--;
      if (c === ';' && depth <= 0) {
        if (cur.trim()) out.push(cur.trim());
        cur = '';
        depth = 0;
        continue;
      }
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function balanced(s, openIdx) {
  let depth = 0;
  let inStr = false;
  for (let i = openIdx; i < s.length; i++) {
    const c = s[i];
    if (c === "'") inStr = !inStr;
    if (inStr) continue;
    if (c === '(') depth++;
    if (c === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error('unbalanced parentheses');
}

const q = s => s.replace(/"/g, '');

export function readRawInvariants(migrationsDir) {
  const checks = new Map(); // `${table}.${name}` -> { table, name, expr }
  const indexes = new Map(); // name -> { table, name, unique, cols: string, where }
  const dirs = fs
    .readdirSync(migrationsDir)
    .filter(d => fs.existsSync(path.join(migrationsDir, d, 'migration.sql')))
    .sort();
  for (const d of dirs) {
    const sql = fs.readFileSync(path.join(migrationsDir, d, 'migration.sql'), 'utf8');
    for (const st of readStatements(sql)) {
      // ALTER TABLE t ADD CONSTRAINT n CHECK (...)[, ADD CONSTRAINT ...] / DROP CONSTRAINT n
      let m = st.match(/^ALTER TABLE\s+(?:ONLY\s+)?(?:IF EXISTS\s+)?("?[\w.]+"?)\s+([\s\S]*)$/i);
      if (m) {
        const table = q(m[1]).replace(/^public\./, '');
        const body = m[2];
        const re = /ADD CONSTRAINT\s+("?\w+"?)\s+CHECK\s*\(/gi;
        let k;
        while ((k = re.exec(body))) {
          const open = k.index + k[0].length - 1;
          const close = balanced(body, open);
          checks.set(`${table}.${q(k[1])}`, {
            table,
            name: q(k[1]),
            expr: body
              .slice(open + 1, close)
              .replace(/\s+/g, ' ')
              .trim(),
          });
        }
        const dre = /DROP CONSTRAINT\s+(?:IF EXISTS\s+)?("?\w+"?)/gi;
        while ((k = dre.exec(body))) checks.delete(`${table}.${q(k[1])}`);
        continue;
      }
      m = st.match(/^CREATE\s+TABLE\s+(?:IF NOT EXISTS\s+)?("?[\w.]+"?)\s*\(/i);
      if (m) {
        const table = q(m[1]).replace(/^public\./, '');
        const body = st;
        const re = /CONSTRAINT\s+("?\w+"?)\s+CHECK\s*\(/gi;
        let k;
        while ((k = re.exec(body))) {
          const open = k.index + k[0].length - 1;
          const close = balanced(body, open);
          checks.set(`${table}.${q(k[1])}`, {
            table,
            name: q(k[1]),
            expr: body
              .slice(open + 1, close)
              .replace(/\s+/g, ' ')
              .trim(),
          });
        }
        continue;
      }
      m = st.match(
        /^CREATE\s+(UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF NOT EXISTS\s+)?("?\w+"?)\s+ON\s+(?:ONLY\s+)?("?[\w.]+"?)\s*(USING\s+\w+\s*)?\(/i
      );
      if (m) {
        const open = st.indexOf('(', m[0].length - 1);
        const close = balanced(st, open);
        const rest = st.slice(close + 1);
        const where = rest.match(/^\s*WHERE\s+([\s\S]*)$/i);
        indexes.set(q(m[2]), {
          table: q(m[3]).replace(/^public\./, ''),
          name: q(m[2]),
          unique: !!m[1],
          using: m[4] ? m[4].trim() : null,
          cols: st
            .slice(open + 1, close)
            .replace(/\s+/g, ' ')
            .trim(),
          where: where ? where[1].replace(/\s+/g, ' ').trim() : null,
        });
        continue;
      }
      m = st.match(/^DROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF EXISTS\s+)?("?\w+"?)/i);
      if (m) indexes.delete(q(m[1]));
    }
  }
  return { checks: [...checks.values()], indexes: [...indexes.values()] };
}

// GLOB templates for the handful of regexes the migrations use. workerd caps LIKE/GLOB patterns at 50 bytes
// (a 67-byte hex pattern failed every swatch insert on a real DO), so keep them short; generate.mjs asserts it.
const REGEX_TO_SQLITE = {
  '^[0-9]{4}$': c => `(length(${c}) = 4 AND ${c} NOT GLOB '*[^0-9]*')`,
  '^[0-9a-f]{64}$': c => `(length(${c}) = 64 AND ${c} NOT GLOB '*[^0-9a-f]*')`,
  '^#[0-9a-f]{6}$': c =>
    `(length(${c}) = 7 AND substr(${c}, 1, 1) = '#' AND substr(${c}, 2) NOT GLOB '*[^0-9a-f]*')`,
  '^#[0-9A-Fa-f]{6}$': c =>
    `(length(${c}) = 7 AND substr(${c}, 1, 1) = '#' AND substr(${c}, 2) NOT GLOB '*[^0-9A-Fa-f]*')`,
  '^\\d{4}-\\d{2}-\\d{2}$': c => `${c} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`,
  '^\\d{2}:\\d{2}$': c => `${c} GLOB '[0-9][0-9]:[0-9][0-9]'`,
  '^[a-z0-9][a-z0-9-]{0,63}$': c =>
    `(length(${c}) BETWEEN 1 AND 64 AND ${c} GLOB '[a-z0-9]*' AND ${c} NOT GLOB '*[^a-z0-9-]*')`,
  '^[a-z][a-z0-9_]{1,31}$': c =>
    `(length(${c}) BETWEEN 2 AND 32 AND ${c} GLOB '[a-z]*' AND ${c} NOT GLOB '*[^a-z0-9_]*')`,
  '^(qamar|souq|jasmine|lamma|dahab)\\.[a-z]+$': c =>
    `(${c} GLOB '*.*' AND ${c} NOT GLOB '*.*.*' AND ${c} NOT GLOB '*[^a-z.]*' AND ${c} NOT GLOB '*.' AND substr(${c}, 1, instr(${c}, '.') - 1) IN ('qamar', 'souq', 'jasmine', 'lamma', 'dahab'))`,
};

export function pgExprToSqlite(expr) {
  let e = expr;
  e = e.replace(/("?\w+"?)\s+~\s+'((?:[^']|'')*)'/g, (_, col, re) => {
    const f = REGEX_TO_SQLITE[re];
    if (!f) throw new Error(`no SQLite translation for regex ${re}`);
    return f(col);
  });
  e = e.replace(
    /([A-Za-z_"][\w"]*)\s+#>>\s+'\{(\w+)\}'/g,
    (_, col, key) => `json_extract(${col}, '$.${key}')`
  );
  e = e.replace(/\bbtrim\(/gi, 'trim(');
  e = e.replace(/=\s*true\b/gi, '= 1').replace(/=\s*false\b/gi, '= 0');
  e = e.replace(/\bchar_length\(/gi, 'length(');
  e = e.replace(/\bjsonb_typeof\(/gi, 'json_type(');
  // text[] columns are TEXT JSON arrays in SQLite, so both array-length spellings are json_array_length.
  e = e.replace(/\b(?:jsonb_array_length|cardinality)\(/gi, 'json_array_length(');
  e = e.replace(/\bIS DISTINCT FROM\b/gi, 'IS NOT');
  e = e.replace(/::\w+(\[\])?/g, '');
  if (
    /\bANY\s*\(|\bARRAY\s*\[|now\(\)|current_setting|~\*|!~/i.test(e) ||
    /::|~/.test(e.replace(/GLOB '[^']*'/g, ''))
  ) {
    throw new Error(`untranslatable Postgres expression: ${expr}`);
  }
  return e;
}

// Predicates (CHECK bodies, partial-index WHERE): a bare boolean column means `col = 1` in SQLite.
// NEVER apply this to an index column list: `(shipment_id)` must stay a column, not become `shipment_id = 1`.
export function pgPredicateToSqlite(expr) {
  const e = pgExprToSqlite(expr);
  return /^"?\w+"?$/.test(e.trim()) && !/^(true|false)$/i.test(e.trim()) ? `${e.trim()} = 1` : e;
}
