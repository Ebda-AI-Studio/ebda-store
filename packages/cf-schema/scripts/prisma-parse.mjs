// A small, strict parser for packages/database/prisma/schema.prisma (models, enums, field and
// block attributes). It exists because the runtime DMMF drops defaults, indexes and uniques, and
// because `@prisma/internals` is not a dependency of this repo. The generator uses it; the parity
// test cross-checks it against the runtime DMMF (names, kinds, nullability) so a parser slip fails
// loudly instead of silently producing a wrong schema.

const SCALARS = new Set([
  'String',
  'Int',
  'BigInt',
  'Float',
  'Decimal',
  'Boolean',
  'DateTime',
  'Json',
  'Bytes',
]);

function stripComment(line) {
  let inStr = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && inStr) {
      i++;
      continue;
    }
    if (c === '"') inStr = !inStr;
    if (!inStr && c === '/' && line[i + 1] === '/') return line.slice(0, i);
  }
  return line;
}

// Reads `@name(...)` / `@@name(...)` attributes, balanced over parentheses and quotes.
function parseAttributes(src) {
  const attrs = [];
  let i = 0;
  while (i < src.length) {
    if (src[i] !== '@') {
      i++;
      continue;
    }
    const block = src[i + 1] === '@';
    i += block ? 2 : 1;
    let name = '';
    while (i < src.length && /[\w.]/.test(src[i])) name += src[i++];
    let args = '';
    if (src[i] === '(') {
      let depth = 0;
      let inStr = false;
      const start = i + 1;
      for (; i < src.length; i++) {
        const c = src[i];
        if (c === '\\' && inStr) {
          i++;
          continue;
        }
        if (c === '"') inStr = !inStr;
        if (inStr) continue;
        if (c === '(') depth++;
        if (c === ')') {
          depth--;
          if (depth === 0) break;
        }
      }
      args = src.slice(start, i);
      i++;
    }
    attrs.push({ name, block, args });
  }
  return attrs;
}

function splitTop(s) {
  const out = [];
  let depth = 0;
  let inStr = false;
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && inStr) {
      cur += c + s[++i];
      continue;
    }
    if (c === '"') inStr = !inStr;
    if (!inStr) {
      if (c === '(' || c === '[') depth++;
      if (c === ')' || c === ']') depth--;
      if (c === ',' && depth === 0) {
        out.push(cur.trim());
        cur = '';
        continue;
      }
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function unquote(s) {
  const t = s.trim();
  if (t.startsWith('"') && t.endsWith('"')) return JSON.parse(t);
  return t;
}

// `[a, b(sort: Desc)]` -> [{ field: 'a', desc: false }, { field: 'b', desc: true }]
function parseFieldList(s) {
  const inner = s.trim().replace(/^\[/, '').replace(/\]$/, '');
  return splitTop(inner).map(part => {
    const m = part.match(/^(\w+)(?:\((.*)\))?$/);
    if (!m) throw new Error(`cannot parse field list entry: ${part}`);
    return { field: m[1], desc: /sort:\s*Desc/.test(m[2] || '') };
  });
}

function namedArg(args, key) {
  for (const a of splitTop(args)) {
    const m = a.match(new RegExp(`^${key}\\s*:\\s*(.*)$`, 's'));
    if (m) return m[1].trim();
  }
  return undefined;
}

export function parseSchema(text) {
  const models = [];
  const enums = [];
  const lines = text.split('\n');
  let cur = null;
  for (const raw of lines) {
    const line = stripComment(raw).trim();
    if (!line) continue;
    if (!cur) {
      const mm = line.match(/^(model|enum|type|datasource|generator)\s+(\w+)\s*\{$/);
      if (mm) cur = { kind: mm[1], name: mm[2], lines: [] };
      continue;
    }
    if (line === '}') {
      if (cur.kind === 'model') models.push(buildModel(cur));
      else if (cur.kind === 'enum')
        enums.push({ name: cur.name, values: cur.lines.map(l => l.split(/\s+/)[0]) });
      cur = null;
      continue;
    }
    cur.lines.push(line);
  }
  const modelNames = new Set(models.map(m => m.name));
  const enumNames = new Set(enums.map(e => e.name));
  for (const m of models) {
    for (const f of m.fields) {
      if (modelNames.has(f.type)) f.kind = 'relation';
      else if (enumNames.has(f.type)) f.kind = 'enum';
      else if (SCALARS.has(f.type)) f.kind = 'scalar';
      else if (f.type.startsWith('Unsupported')) f.kind = 'unsupported';
      else throw new Error(`unknown type ${f.type} on ${m.name}.${f.name}`);
    }
  }
  return { models, enums };
}

function buildModel(raw) {
  const model = {
    name: raw.name,
    dbName: raw.name,
    fields: [],
    uniques: [],
    indexes: [],
    id: null,
  };
  for (const line of raw.lines) {
    if (line.startsWith('@@')) {
      for (const a of parseAttributes(line)) {
        if (a.name === 'map') model.dbName = unquote(a.args);
        else if (a.name === 'id') model.id = parseFieldList(splitTop(a.args)[0]).map(x => x.field);
        else if (a.name === 'unique')
          model.uniques.push({
            fields: parseFieldList(splitTop(a.args)[0]),
            map: unquote(namedArg(a.args, 'map') ?? '""') || null,
          });
        else if (a.name === 'index')
          model.indexes.push({
            fields: parseFieldList(splitTop(a.args)[0]),
            map: unquote(namedArg(a.args, 'map') ?? '""') || null,
          });
        else throw new Error(`unhandled block attribute @@${a.name} on ${raw.name}`);
      }
      continue;
    }
    const m = line.match(/^(\w+)\s+(Unsupported\("[^"]*"\)|[\w]+)(\[\])?(\?)?\s*(.*)$/);
    if (!m) throw new Error(`cannot parse field line in ${raw.name}: ${line}`);
    const f = { name: m[1], type: m[2], list: !!m[3], optional: !!m[4], column: m[1], attrs: {} };
    for (const a of parseAttributes(m[5])) {
      if (a.name === 'map') f.column = unquote(a.args);
      else if (a.name === 'id') f.attrs.id = true;
      else if (a.name === 'unique') f.attrs.unique = true;
      else if (a.name === 'updatedAt') f.attrs.updatedAt = true;
      else if (a.name === 'default') f.attrs.default = a.args.trim();
      else if (a.name.startsWith('db.'))
        f.attrs.db = `${a.name.slice(3)}${a.args ? `(${a.args})` : ''}`;
      else if (a.name === 'relation') {
        const args = splitTop(a.args);
        const fields = namedArg(a.args, 'fields');
        const references = namedArg(a.args, 'references');
        f.attrs.relation = {
          fields: fields ? parseFieldList(fields).map(x => x.field) : [],
          references: references ? parseFieldList(references).map(x => x.field) : [],
          onDelete: namedArg(a.args, 'onDelete') ?? null,
          onUpdate: namedArg(a.args, 'onUpdate') ?? null,
          name:
            args[0] && !args[0].includes(':')
              ? unquote(args[0])
              : namedArg(a.args, 'name')
                ? unquote(namedArg(a.args, 'name'))
                : null,
        };
      } else throw new Error(`unhandled attribute @${a.name} on ${raw.name}.${f.name}`);
    }
    model.fields.push(f);
  }
  return model;
}
