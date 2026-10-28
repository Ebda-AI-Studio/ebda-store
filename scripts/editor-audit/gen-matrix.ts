/**
 * The editor control matrix: one generated, committed answer to "which editor
 * control actually does something on which skin, and what is missing".
 *
 * Axes are read from code, not docs: skins and looks from the look registry,
 * sections and settings from `SECTION_REGISTRY`, theme controls from
 * `THEME_SETTINGS_SCHEMA`, the form page builder's write surface from its
 * source (`classic-manifest.ts`). Each control is classified from two
 * independent sources (see `classify.ts`): a static reverse grep for its key
 * in the code the skin reaches, and the flip probe (`probe.tsx`).
 *
 * Run under vitest (the probe mocks the storefront contexts):
 *   npm run editor:matrix         regenerate docs/ebda/templates/editor-matrix.{md,json}
 *   npm run editor:matrix:check   fail if they are stale or a row is not accepted in baseline.json
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import {
  IMAGE_TARGETS,
  LOOKS,
  MOBILE_PROP_LEGACY_NAME,
  SECTION_REGISTRY,
  THEME_SETTINGS_SCHEMA,
  rulesOf,
  type SettingDefinition,
  type ShownRule,
  type TemplateId,
} from '@ebda/shared';
import { classify, type RowStatus } from './classify';
import { buildClassicManifest } from './classic-manifest';
import { PROBE_UNREACHABLE, probeSetting, probeValues, probeMarker } from './probe';

const ROOT = path.resolve(__dirname, '../..');
const WEB = path.join(ROOT, 'apps/web/src');

export interface MatrixRow {
  /** `<skin>|<surface>|<control>`, or `<look>|<surface>|design:<key>` for a look-mix check. */
  id: string;
  skin: string;
  /** The looks that render on this skin (a control's status is a property of the skin). */
  looks: string[];
  surface: string;
  control: string;
  status: RowStatus;
  /** `static+probe`, `static`, `probe-error:...`, `mix`, `manifest`. */
  evidence: string;
  /** For `classic-only`: the plan's capability id (P-01 to P-19). */
  capability?: string;
}

export interface Matrix {
  version: 1;
  summary: Record<RowStatus, number>;
  coverage: { looks: string[]; skins: string[]; sectionTypesMissing: string[] };
  rows: MatrixRow[];
}

export interface BaselineEntry {
  id: string;
  status: RowStatus;
  reason: string;
}

/* ---------- static source: the code a skin reaches ---------- */

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) out.push(p);
  }
  return out;
}
const textCache = new Map<string, string>();
const textOf = (dir: string): string => {
  if (!textCache.has(dir))
    textCache.set(
      dir,
      walk(dir)
        .map(f => readFileSync(f, 'utf8'))
        .join('\n')
    );
  return textCache.get(dir)!;
};

/** What a skin's section renderers can read: the builder, the shared templates and the skin's own folder. */
const skinSource = (skin: string) =>
  [
    textOf(path.join(WEB, 'builder')),
    textOf(path.join(WEB, 'templates/shared')),
    textOf(path.join(WEB, 'templates', skin)),
  ].join('\n');

const reads = (source: string, key: string) => new RegExp(`\\b${key}\\b`).test(source);

/**
 * Controls whose effect the flip probe cannot see in static HTML, each with the file that reads it:
 * a timer (the slideshow's autoplay) and what the home page asks the API for (how many products,
 * which reviews). Static evidence only, and the named file MUST read the key, so a control whose
 * reader is deleted turns `no-op` here too.
 */
export const BEHAVIOUR_READERS: Readonly<Record<string, { file: string; pattern: RegExp }>> = {
  'hero/autoplayMs': {
    file: 'apps/web/src/templates/shared/HeroSlider.tsx',
    pattern: /setInterval\(tick, autoplayMs\)/,
  },
  'new-arrivals/limit': {
    file: 'apps/web/src/app/HomePageBody.tsx',
    pattern: /layout\.newArrivals\.limit/,
  },
  'best-sellers/limit': {
    file: 'apps/web/src/app/HomePageBody.tsx',
    pattern: /layout\.bestSellers\.limit/,
  },
  'product-carousel/categoryFetchLimit': {
    file: 'apps/web/src/app/HomePageBody.tsx',
    pattern: /e\.categoryFetchLimit/,
  },
  'testimonials/minRating': {
    file: 'apps/web/src/app/HomePageBody.tsx',
    pattern: /layout\.testimonials\.minRating/,
  },
  // the "Show gifts" link appears only after a shopper picks an occasion (client state)
  'gift-finder/buttonText': {
    file: 'apps/web/src/builder/sections/GiftFinderSection.tsx',
    pattern: /settings\.buttonText/,
  },
  // Dahab fetches the hover photograph only where hover exists (a post-hydration media query), which
  // static HTML cannot show; keyed `<skin>|<type>/<id>` so the other skins stay probed
  ...Object.fromEntries(
    ['new-arrivals', 'best-sellers', 'product-carousel'].map(type => [
      `dahab|${type}/showHover`,
      {
        file: 'apps/web/src/templates/dahab/ProductCard.tsx',
        pattern: /showHover !== false && canHover && secondary\?\.url/,
      },
    ])
  ),
  // theme controls the header skins reach through the shared resolver
  'theme/headerLogoPlacement': {
    file: 'packages/shared/src/looks/compose.ts',
    pattern: /theme\?\.headerLogoPlacement/,
  },
  'theme/headerSearch': {
    file: 'packages/shared/src/looks/compose.ts',
    pattern: /theme\?\.headerSearch/,
  },
  'theme/headerWordmark': {
    file: 'packages/shared/src/looks/compose.ts',
    pattern: /theme\?\.headerWordmark/,
  },
  'theme/cardHeart': {
    file: 'packages/shared/src/looks/traits.ts',
    pattern: /cardHeart/,
  },
  'theme/cardSwatches': {
    file: 'packages/shared/src/looks/traits.ts',
    pattern: /cardSwatches/,
  },
  'theme/cardTags': {
    file: 'packages/shared/src/looks/traits.ts',
    pattern: /cardTags/,
  },
  'theme/gridGutter': {
    file: 'packages/shared/src/looks/traits.ts',
    pattern: /gridGutter/,
  },
  'theme/headingWeight': {
    file: 'packages/shared/src/looks/traits.ts',
    pattern: /headingWeight/,
  },
  'theme/priceColour': {
    file: 'packages/shared/src/looks/traits.ts',
    pattern: /priceColour/,
  },
  'theme/tabBar': {
    file: 'packages/shared/src/looks/compose.ts',
    pattern: /theme\?\.tabBar/,
  },
  'theme/heroRatio': {
    file: 'packages/shared/src/looks/mock-tokens.ts',
    pattern: /theme\?\.heroRatio/,
  },
  'testimonials/verifiedOnly': {
    file: 'apps/web/src/app/HomePageBody.tsx',
    pattern: /layout\.testimonials\.verifiedOnly/,
  },
};

/** The rules of `shownFor` that can hold on this skin (its template, and a look the skin has). */
export function rulesForSkin(
  shownFor: SettingDefinition['shownFor'],
  skin: string,
  looks: readonly string[]
): ShownRule[] {
  return rulesOf(shownFor).filter(
    r =>
      (!r.templates || r.templates.includes(skin as TemplateId)) &&
      !r.notTemplates?.includes(skin as TemplateId) &&
      (!r.looks || r.looks.some(l => looks.includes(l)))
  );
}
/** The settings to apply so a rule's variant is the one on screen (its first listed value of each key). */
export const contextOf = (r: ShownRule): Record<string, unknown> =>
  Object.fromEntries(Object.entries(r.variants ?? {}).map(([k, v]) => [k, v[0]]));

/** Alt text is written through the picture's own alt prompt (ImageTarget.alt), not inline. */
const isAltOfAnImage = (type: string, key: string) =>
  (IMAGE_TARGETS[type]?.section ?? []).some(t => t.alt && (t.alt.en === key || t.alt.ar === key));

/* ---------- axes ---------- */

const isSkinBuilt = (skin: string) => existsSync(path.join(WEB, 'templates', skin, 'index.ts'));

function settingKeys(s: SettingDefinition): string[] {
  return s.localized ? [s.id, `${s.id}Ar`] : [s.id];
}

/**
 * Controls the registry hides on a skin although the flip probe shows they work there (in any
 * variant a rule names): `shownFor` that narrows too far. Must be empty (Ruling EP-1).
 */
export function hiddenButWired(): string[] {
  const out: string[] = [];
  const skins = [...new Set(LOOKS.map(l => l.skin))].sort();
  for (const skin of skins) {
    const looks = LOOKS.filter(l => l.skin === skin).map(l => l.id);
    for (const def of SECTION_REGISTRY.filter(
      d => d.group === 'template' && d.pages.includes('home')
    ))
      for (const s of def.settings) {
        if (s.shownFor === undefined) continue;
        if (rulesForSkin(s.shownFor, skin, looks).length > 0) continue;
        const values = probeValues(s);
        if (!values) continue;
        for (const r of rulesOf(s.shownFor))
          for (const k of settingKeys(s))
            if (
              probeSetting(
                skin as TemplateId,
                def.type,
                k,
                values,
                contextOf(r),
                r.looks?.find(l => looks.includes(l))
              ).differs
            )
              out.push(`${skin}|section:${def.type}|${s.id}`);
      }
  }
  return [...new Set(out)];
}

export function buildMatrix(): Matrix {
  const rows: MatrixRow[] = [];
  const skins = [...new Set(LOOKS.map(l => l.skin))].sort();
  const looksOf = (skin: string) => LOOKS.filter(l => l.skin === skin).map(l => l.id);
  // the home document's sections; product/collection/cart page sections have no settings (VE-12)
  const templateSections = SECTION_REGISTRY.filter(
    d => d.group === 'template' && d.pages.includes('home')
  );

  // 1. Section controls and theme controls, once per skin.
  for (const skin of skins) {
    const src = skinSource(skin);
    const looks = looksOf(skin);
    const built = LOOKS.filter(l => l.skin === skin).some(l => l.status === 'built');
    for (const def of templateSections) {
      for (const s of def.settings) {
        // A control the registry narrows (`shownFor`) is judged only where it is shown: a skin or
        // look no rule reaches never offers it, so it cannot lie there.
        const rules = s.shownFor === undefined ? null : rulesForSkin(s.shownFor, skin, looks);
        if (rules && rules.length === 0) continue;
        const values = PROBE_UNREACHABLE.has(def.type) ? null : probeValues(s);
        // typography / dividers are compound editors: their effect is a nested object, so the probe
        // flips no scalar. They are static evidence only (the renderer reads the key).
        const compound = s.type === 'typography' || s.type === 'dividers';
        const keys = settingKeys(s);
        const reader =
          BEHAVIOUR_READERS[`${skin}|${def.type}/${s.id}`] ??
          BEHAVIOUR_READERS[`${def.type}/${s.id}`];
        const staticHit = reader
          ? reader.pattern.test(readFileSync(path.join(ROOT, reader.file), 'utf8'))
          : keys.some(k => reads(src, k));
        const probeable = !!values && !compound && !reader;
        let differs = false;
        let evidence = reader ? `static (${path.basename(reader.file)})` : 'static';
        let error: string | undefined;
        if (probeable) {
          const contexts = rules
            ? rules.map(r => ({ ctx: contextOf(r), look: r.looks?.find(l => looks.includes(l)) }))
            : [{ ctx: {}, look: undefined }];
          for (const k of keys)
            for (const c of contexts) {
              const r = probeSetting(skin as TemplateId, def.type, k, values!, c.ctx, c.look);
              if (r.error) error = r.error;
              if (r.differs) differs = true;
            }
          evidence = error ? `probe-error: ${error}` : 'static+probe';
        }
        // A text or image whose rendered node has no canvas marker (Tasks 2 and 3).
        const markable =
          (s.type === 'text' || s.type === 'textarea' || s.type === 'image') &&
          !isAltOfAnImage(def.type, s.id);
        const markerMissing =
          built && markable && differs && !compound
            ? keys.some(k => probeMarker(skin as TemplateId, def.type, k, s.type) === 'unmarked')
            : false;
        rows.push({
          id: `${skin}|section:${def.type}|${s.id}`,
          skin,
          looks,
          surface: `section:${def.type}`,
          control: s.id,
          status: classify({
            shown: true,
            staticHit,
            probeDiffers: differs,
            probeable,
            markerMissing,
          }),
          evidence,
        });
      }
      // Block settings: static evidence only (a block needs its section's content to render).
      for (const b of def.blocks)
        for (const s of b.settings) {
          rows.push({
            id: `${skin}|section:${def.type}/${b.type}|${s.id}`,
            skin,
            looks,
            surface: `section:${def.type}/${b.type}`,
            control: s.id,
            status: classify({
              shown: true,
              staticHit: settingKeys(s).some(k => reads(src, k)),
              probeable: false,
            }),
            evidence: 'static',
          });
        }
    }
    // Theme controls: static evidence (the storefront theme emitter reads them). A control the registry
    // narrows is judged only on the skins it is offered to.
    const themeSrc = textOf(WEB);
    for (const g of THEME_SETTINGS_SCHEMA)
      for (const s of g.settings) {
        if (s.shownFor !== undefined && rulesForSkin(s.shownFor, skin, looks).length === 0)
          continue;
        const reader = BEHAVIOUR_READERS[`theme/${s.id}`];
        const staticHit = reader
          ? reader.pattern.test(readFileSync(path.join(ROOT, reader.file), 'utf8'))
          : reads(themeSrc, s.id);
        rows.push({
          id: `${skin}|theme|${s.id}`,
          skin,
          looks,
          surface: 'theme',
          control: s.id,
          status: classify({ shown: true, staticHit, probeable: false }),
          evidence: reader ? `static (${path.basename(reader.file)})` : 'static',
        });
      }
  }

  // 2. Each look's mix: every design / preset key it uses must have an editor control.
  const sectionTypes = new Map(templateSections.map(d => [d.type, d]));
  for (const look of LOOKS) {
    const pendingSkin = look.status !== 'built' && !isSkinBuilt(look.skin);
    if (pendingSkin) {
      rows.push({
        id: `${look.id}|look|skin`,
        skin: look.skin,
        looks: [look.id],
        surface: 'look',
        control: 'skin',
        status: classify({ lookStatus: look.status, skinExists: false }),
        evidence: 'mix',
      });
      continue;
    }
    for (const spec of look.sections ?? []) {
      const def = sectionTypes.get(spec.type);
      const known = new Set(def?.settings.flatMap(settingKeys) ?? []);
      // The mobile-only legacy names (`layoutMobile`) are viewport overrides of a registry setting.
      for (const legacy of Object.values(
        (def?.legacyKey && MOBILE_PROP_LEGACY_NAME[def.legacyKey]) || {}
      ))
        known.add(legacy);
      if (!def)
        rows.push({
          id: `${look.id}|section:${spec.type}|add`,
          skin: look.skin,
          looks: [look.id],
          surface: `section:${spec.type}`,
          control: 'add',
          status: classify({ inMix: true, hasControl: false }),
          evidence: 'mix',
        });
      for (const [bag, obj] of [
        ['design', spec.design],
        ['preset', spec.preset],
      ] as const)
        for (const key of Object.keys(obj ?? {}))
          if (def && !known.has(key))
            rows.push({
              id: `${look.id}|section:${spec.type}|${bag}:${key}`,
              skin: look.skin,
              looks: [look.id],
              surface: `section:${spec.type}`,
              control: `${bag}:${key}`,
              status: classify({ inMix: true, hasControl: false }),
              evidence: 'mix',
            });
    }
  }

  // 3. The form page builder's write surface (what must be covered before it is deleted).
  for (const e of buildClassicManifest()) {
    if (e.status === 'wired' || e.status === 'retired') continue;
    rows.push({
      id: `classic|${e.kind}|${e.key}`,
      skin: 'all',
      looks: [],
      surface: `classic:${e.kind}`,
      control: e.key,
      status: classify({ classicOnly: true }),
      evidence: 'manifest',
      ...(e.capability ? { capability: e.capability } : {}),
    });
  }

  rows.sort((a, b) => a.id.localeCompare(b.id));
  const summary = {
    wired: 0,
    'no-op': 0,
    missing: 0,
    'pending-template': 0,
    'marker-pending': 0,
    'classic-only': 0,
    exempt: 0,
  } as Matrix['summary'];
  for (const r of rows) summary[r.status]++;
  const covered = new Set(
    rows.filter(r => r.surface.startsWith('section:')).map(r => r.surface.slice(8).split('/')[0])
  );
  return {
    version: 1,
    summary,
    coverage: {
      looks: LOOKS.map(l => l.id).sort(),
      skins,
      sectionTypesMissing: templateSections.map(d => d.type).filter(t => !covered.has(t)),
    },
    rows,
  };
}

/** A readable summary: counts per skin and section, and the rows that are not wired. */
export function renderMarkdown(m: Matrix): string {
  const s = m.summary;
  const out: string[] = [
    '# Editor control matrix',
    '',
    '> Generated by `npm run editor:matrix` (scripts/editor-audit). Do not edit by hand. Plan: `docs/plans/2026-10-22-visual-editor.md` Task 5.',
    '',
    `wired ${s.wired} · no-op ${s['no-op']} · missing ${s.missing} · marker-pending ${s['marker-pending']} · classic-only ${s['classic-only']} · pending-template ${s['pending-template']}`,
    '',
    'Evidence: `static+probe` = a reader exists AND flipping the value changes the rendered HTML; `static` = a reader exists (theme, block and chrome controls cannot be rendered in isolation); `manifest` = from the classic page builder source.',
    '',
  ];
  for (const skin of m.coverage.skins) {
    const rows = m.rows.filter(r => r.skin === skin);
    out.push(`## ${skin}`, '', `Looks: ${[...new Set(rows.flatMap(r => r.looks))].join(', ')}`, '');
    out.push(
      '| surface | wired | no-op | missing | marker-pending |',
      '| --- | ---: | ---: | ---: | ---: |'
    );
    const surfaces = [...new Set(rows.map(r => r.surface))];
    for (const surface of surfaces) {
      const sr = rows.filter(r => r.surface === surface);
      const n = (st: RowStatus) => sr.filter(r => r.status === st).length;
      out.push(
        `| ${surface} | ${n('wired')} | ${n('no-op')} | ${n('missing')} | ${n('marker-pending')} |`
      );
    }
    const bad = rows.filter(r => r.status !== 'wired');
    if (bad.length) {
      out.push('', '<details><summary>Not wired</summary>', '');
      for (const r of bad)
        out.push(`- \`${r.surface}\` · \`${r.control}\` · ${r.status} (${r.evidence})`);
      out.push('', '</details>');
    }
    out.push('');
  }
  const classic = m.rows.filter(r => r.skin === 'all');
  out.push('## Classic page builder (classic-only)', '');
  for (const r of classic) out.push(`- ${r.capability ?? '?'} · \`${r.control}\``);
  out.push('');
  return out.join('\n');
}

export const MATRIX_JSON = 'docs/ebda/templates/editor-matrix.json';
export const MATRIX_MD = 'docs/ebda/templates/editor-matrix.md';
export const BASELINE_JSON = 'scripts/editor-audit/baseline.json';

export function readBaseline(): BaselineEntry[] {
  return JSON.parse(readFileSync(path.join(ROOT, BASELINE_JSON), 'utf8')) as BaselineEntry[];
}
export const NOT_WIRED: RowStatus[] = ['no-op', 'missing', 'marker-pending', 'classic-only'];
