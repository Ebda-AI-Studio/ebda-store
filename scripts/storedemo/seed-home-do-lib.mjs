// The pure half of seed-home-do.mjs (Ruling DEMO-SEED-DO-1): build a demo home from the store's current state, compare,
// write through the Worker's operator channel and read it back. No Node-only import, so the workerd test
// (apps/api/workers-test/demo-home.test.ts) runs exactly this code against a real StoreDO.

/** JSON with sorted keys, so two documents compare by content, not key order. */
export function stableJson(v) {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .filter(k => v[k] !== undefined)
      .sort()
      .map(k => `${JSON.stringify(k)}:${stableJson(v[k])}`)
      .join(',')}}`;
  return JSON.stringify(v);
}

/** The page's own content: the read side overlays the store's live site settings onto `siteSettings`. */
const pageBody = d => stableJson({ sections: d.sections, sectionGroups: d.sectionGroups });
const visibleTypes = d => (d.sections ?? []).filter(s => !s.hidden).map(s => s.type);

/**
 * Build `spec`'s demo home from the store's state (the Worker's GET). `assets` = { img(file), video }.
 * `unchanged` = the published page already holds exactly this content.
 */
export function buildDemoHome(spec, state, assets) {
  const definition = spec.buildHome(state.definition, {
    img: assets.img,
    video: assets.video,
    productIdBySlug: new Map(Object.entries(state.productIdBySlug ?? {})),
  });
  const unchanged =
    state.source === 'published' && pageBody(definition) === pageBody(state.definition);
  return {
    definition,
    unchanged,
    before: visibleTypes(state.definition),
    after: visibleTypes(definition),
  };
}

/**
 * Seed one demo home. `http(method, path, body?)` returns the Worker's `data` or throws; `demoSlugs` is the allow-list
 * (the five showroom slugs). Dry run unless `apply`. Returns { slug, status, line }.
 */
export async function seedOne(spec, { http, apply, assets, demoSlugs }) {
  if (!demoSlugs.has(spec.slug)) throw new Error(`refused: ${spec.slug} is not a demo store`);
  const path = `/api/v1/internal/demo-home/${spec.slug}`;
  const state = await http('GET', path);
  const plan = buildDemoHome(spec, state, assets);
  const head = `${spec.slug} (${state.storeId}, look ${state.look}) rev ${state.rev} [${state.source}]`;
  if (plan.unchanged) return { slug: spec.slug, status: 'unchanged', line: `${head}: unchanged` };
  const added = [...new Set(plan.after.filter(t => !plan.before.includes(t)))];
  const diff = `${plan.before.length} -> ${plan.after.length} visible sections${added.length ? `, adds ${added.join(', ')}` : ''}`;
  if (!apply)
    return { slug: spec.slug, status: 'would-change', line: `${head}: WOULD publish (${diff})` };
  const put = await http('PUT', path, { baseRev: state.rev, definition: plan.definition });
  const after = await http('GET', path);
  if (!buildDemoHome(spec, after, assets).unchanged)
    throw new Error(
      `${spec.slug}: published rev ${put.rev} but the read-back differs from the built home`
    );
  return {
    slug: spec.slug,
    status: 'published',
    line: `${head}: published rev ${put.rev} (${diff}), read back OK`,
  };
}

/** `http` for seedOne over fetch, with the operator bearer. */
export function httpClient(apiUrl, token, fetchImpl = fetch) {
  return async (method, path, body) => {
    const res = await fetchImpl(apiUrl.replace(/\/$/, '') + path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.success === false)
      throw new Error(
        `${method} ${path}: HTTP ${res.status} ${j.error?.code ?? ''} ${j.error?.message ?? ''} ${
          j.error?.details ? JSON.stringify(j.error.details).slice(0, 600) : ''
        }`.trim()
      );
    return j.data;
  };
}
