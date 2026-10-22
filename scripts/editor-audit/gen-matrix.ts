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
  LOOKS,
  MOBILE_PROP_LEGACY_NAME,
  SECTION_REGISTRY,
  THEME_SETTINGS_SCHEMA,
  type SettingDefinition,
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

/* ---------- axes ---------- */

const isSkinBuilt = (skin: string) => existsSync(path.join(WEB, 'templates', skin, 'index.ts'));

function settingKeys(s: SettingDefinition): string[] {
  return s.localized ? [s.id, `${s.id}Ar`] : [s.id];
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
        const values = PROBE_UNREACHABLE.has(def.type) ? null : probeValues(s);
        // typography / dividers are compound editors: their effect is a nested object, so the probe
        // flips no scalar. They are static evidence only (the renderer reads the key).
        const compound = s.type === 'typography' || s.type === 'dividers';
        const keys = settingKeys(s);
        const staticHit = keys.some(k => reads(src, k));
        let differs = false;
        let evidence = 'static';
        let error: string | undefined;
        if (values && !compound) {
          for (const k of keys) {
            const r = probeSetting(skin as TemplateId, def.type, k, values);
            if (r.error) error = r.error;
            if (r.differs) differs = true;
          }
          evidence = error ? `probe-error: ${error}` : 'static+probe';
        }
        // A text or image whose rendered node has no canvas marker (Tasks 2 and 3).
        const markable = s.type === 'text' || s.type === 'textarea' || s.type === 'image';
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
            probeable: !!values && !compound,
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
    // Theme controls: static evidence (the storefront theme emitter reads them).
    const themeSrc = textOf(WEB);
    for (const g of THEME_SETTINGS_SCHEMA)
      for (const s of g.settings)
        rows.push({
          id: `${skin}|theme|${s.id}`,
          skin,
          looks,
          surface: 'theme',
          control: s.id,
          status: classify({ shown: true, staticHit: reads(themeSrc, s.id), probeable: false }),
          evidence: 'static',
        });
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
