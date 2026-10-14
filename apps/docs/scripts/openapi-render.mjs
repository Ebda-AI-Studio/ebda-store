// Static OpenAPI renderer: spec object -> HTML string. No client JS, no runtime API calls.
import { esc } from '@ebda/site-kit/build/shell';

const refName = ref => ref.split('/').pop();

function resolve(spec, schema) {
  if (schema && schema.$ref) {
    const name = refName(schema.$ref);
    return { name, schema: spec.components?.schemas?.[name] ?? {} };
  }
  return { name: null, schema: schema ?? {} };
}

function typeLabel(spec, schema) {
  if (!schema) return 'any';
  if (schema.$ref) return refName(schema.$ref);
  if (schema.type === 'array') return `${typeLabel(spec, schema.items)}[]`;
  let t = schema.type ?? 'object';
  if (schema.format) t += ` (${schema.format})`;
  if (schema.enum) t += `: ${schema.enum.map(e => JSON.stringify(e)).join(' | ')}`;
  return t;
}

/** Flatten an object schema into table rows; nested inline objects use dotted names. */
function rows(spec, schema, prefix = '', depth = 0, seen = new Set()) {
  const { name, schema: s } = resolve(spec, schema);
  if (name) {
    if (seen.has(name) || depth > 3) return [];
    seen = new Set(seen).add(name);
  }
  const target = s.type === 'array' ? resolve(spec, s.items) : { schema: s };
  const props = target.schema?.properties ?? {};
  const required = new Set(target.schema?.required ?? []);
  const out = [];
  for (const [key, val] of Object.entries(props)) {
    const full = prefix + key;
    out.push({
      name: full,
      type: typeLabel(spec, val),
      required: required.has(key),
      desc: [
        val.description,
        val.example !== undefined ? `Example: ${JSON.stringify(val.example)}` : '',
      ]
        .filter(Boolean)
        .join(' '),
    });
    const inner = resolve(spec, val.type === 'array' ? val.items : val);
    if (!val.$ref && (val.type === 'object' || val.properties)) {
      out.push(...rows(spec, val, full + '.', depth + 1, seen));
    } else if (inner.name && depth < 2) {
      out.push(...rows(spec, val.type === 'array' ? val.items : val, full + '.', depth + 1, seen));
    }
  }
  return out;
}

function table(spec, schema, labels, ctx = '') {
  const r = rows(spec, schema);
  if (!r.length) return '';
  return `<div class="table-scroll" tabindex="0" role="region" aria-label="${esc(labels.fields + (ctx ? `: ${ctx}` : ''))}"><table><thead><tr><th>${esc(labels.field)}</th><th>${esc(labels.type)}</th><th>${esc(labels.description)}</th></tr></thead><tbody>${r
    .map(
      x =>
        `<tr><td><code>${esc(x.name)}</code>${x.required ? ` <span class="muted small">(${esc(labels.required)})</span>` : ''}</td><td><code>${esc(x.type)}</code></td><td>${esc(x.desc)}</td></tr>`
    )
    .join('')}</tbody></table></div>`;
}

function exampleOf(spec, schema, depth = 0) {
  const { schema: s } = resolve(spec, schema);
  if (s.example !== undefined) return s.example;
  if (depth > 3) return null;
  if (s.type === 'array') return [exampleOf(spec, s.items, depth + 1)];
  if (s.properties) {
    return Object.fromEntries(
      Object.entries(s.properties).map(([k, v]) => [k, exampleOf(spec, v, depth + 1)])
    );
  }
  if (s.enum) return s.enum[0];
  return { string: 'string', integer: 0, number: 0, boolean: true }[s.type] ?? null;
}

export function slugOp(method, p) {
  return `${method}-${p}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * @returns {{ html: string, toc: {id:string,text:string,level:number}[] }}
 */
export function renderOpenApi(spec, labels, baseUrl) {
  const byTag = new Map();
  for (const [p, item] of Object.entries(spec.paths ?? {})) {
    for (const [method, op] of Object.entries(item)) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
      const tag = op.tags?.[0] ?? 'Other';
      if (!byTag.has(tag)) byTag.set(tag, []);
      byTag.get(tag).push({ method, path: p, op });
    }
  }
  const toc = [];
  let html = '';
  for (const [tag, ops] of byTag) {
    const tagId = 'tag-' + tag.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    toc.push({ id: tagId, text: tag, level: 2 });
    html += `<h2 id="${tagId}">${esc(tag)}</h2>`;
    for (const { method, path: p, op } of ops) {
      const id = slugOp(method, p);
      const secured = op.security === undefined || op.security.length > 0;
      html += `<section class="op" aria-labelledby="${id}"><h3 id="${id}"><span class="method">${method.toUpperCase()}</span> <span>${esc(baseUrl + p)}</span></h3>`;
      html += `<p><strong>${esc(op.summary ?? '')}</strong>${op.description ? ' ' + esc(op.description) : ''}</p>`;
      html += `<p class="muted small">${esc(secured ? labels.authRequired : labels.authNone)}</p>`;
      const params = op.parameters ?? [];
      if (params.length) {
        html += `<h4>${esc(labels.parameters)}</h4><div class="table-scroll" tabindex="0" role="region" aria-label="${esc(labels.parameters + `: ${op.summary ?? p}`)}"><table><thead><tr><th>${esc(labels.field)}</th><th>${esc(labels.in)}</th><th>${esc(labels.type)}</th><th>${esc(labels.description)}</th></tr></thead><tbody>${params
          .map(
            q =>
              `<tr><td><code>${esc(q.name)}</code>${q.required ? ` <span class="muted small">(${esc(labels.required)})</span>` : ''}</td><td>${esc(q.in)}</td><td><code>${esc(typeLabel(spec, q.schema))}</code></td><td>${esc(q.description ?? '')}</td></tr>`
          )
          .join('')}</tbody></table></div>`;
      }
      const body = op.requestBody?.content?.['application/json']?.schema;
      if (body) {
        html += `<h4>${esc(labels.requestBody)}</h4>${table(spec, body, labels, op.summary ?? p)}<pre><code>${esc(JSON.stringify(exampleOf(spec, body), null, 2))}</code></pre>`;
      }
      html += `<h4>${esc(labels.responses)}</h4><ul>`;
      for (const [code, r] of Object.entries(op.responses ?? {})) {
        const schema = r.content?.['application/json']?.schema;
        html += `<li><code>${esc(code)}</code> ${esc(r.description ?? '')}${schema ? ` (<code>${esc(typeLabel(spec, schema))}</code>)` : ''}</li>`;
      }
      html += '</ul></section>';
    }
  }
  const schemas = spec.components?.schemas ?? {};
  toc.push({ id: 'schemas', text: labels.schemas, level: 2 });
  html += `<h2 id="schemas">${esc(labels.schemas)}</h2>`;
  for (const name of Object.keys(schemas)) {
    html += `<h3 id="schema-${esc(name.toLowerCase())}">${esc(name)}</h3>${table(spec, { $ref: `#/components/schemas/${name}` }, labels, name)}`;
  }
  return { html, toc };
}
