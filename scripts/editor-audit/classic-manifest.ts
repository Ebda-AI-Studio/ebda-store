/**
 * The classic page builder's write surface, generated from its source
 * (`apps/admin/src/app/stores/[id]/page-builder/`). It is the checklist the
 * visual editor must cover before that page is deleted (Ruling VE-6): every
 * layout field the form writes, every `siteSettings` key it references and
 * every API path it calls. Each entry is mapped to a visual-editor control, or
 * is `classic-only`.
 *
 * Pure file reads, deterministic; no network.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  SECTION_REGISTRY,
  SITE_SETTING_KEYS,
  sectionDefinitionForLegacyKey,
  type SettingDefinition,
} from '@ebda/shared';

const ROOT = path.resolve(__dirname, '../..');
const DIR = path.join(ROOT, 'apps/admin/src/app/stores/[id]/page-builder');
const SOURCES = ['page.tsx', 'CategoryLayoutButtons.tsx', 'ModeButton.tsx'];

export interface ManifestEntry {
  /** `field` | `site-setting` | `api`. */
  kind: 'field' | 'site-setting' | 'component' | 'api';
  /** `<legacyKey>.<field>`, the `siteSettings` key, or `<METHOD> <path>`. */
  key: string;
  /** The visual-editor control that covers it (`section:<type>/<setting>`), or null. */
  builder: string | null;
  status: 'wired' | 'classic-only' | 'retired';
  /** The plan's capability id (P-01 to P-19) for a classic-only entry. */
  capability?: string;
  reason?: string;
}

/** Top-level `key:` names of an object-literal body (nested braces / brackets / parens skipped). */
export function topLevelKeys(body: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  let token = '';
  let quote: string | null = null;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      if (ch === quote && body[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if ('{[('.includes(ch)) depth++;
    else if ('}])'.includes(ch)) depth--;
    else if (depth === 0) {
      if (ch === ',') token = '';
      else if (ch === ':') {
        const m = /([A-Za-z_]\w*)\s*$/.exec(token);
        if (m) keys.push(m[1]);
        token = '';
      } else token += ch;
      continue;
    }
    if (depth === 0) token += ch;
  }
  return [...new Set(keys)];
}

/** Every `updateSection('<key>', s => ({ ...s, a: x, b: y }))` in the sources: legacy key -> fields written. */
export function writtenFields(source: string): Record<string, string[]> {
  const out: Record<string, Set<string>> = {};
  const re = /updateSection\(\s*'(\w+)'\s*,\s*(?:\(\s*\w+\s*\)|\w+)\s*=>\s*\(\{/g;
  for (let m = re.exec(source); m; m = re.exec(source)) {
    // Read the balanced object literal that starts at the `{` we just matched.
    let depth = 1;
    let i = re.lastIndex;
    const start = i;
    while (i < source.length && depth > 0) {
      const ch = source[i++];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    const body = source.slice(start, i - 1).replace(/^\s*\.\.\.\s*\w+\s*,?/, '');
    for (const k of topLevelKeys(body)) (out[m[1]] ??= new Set()).add(k);
  }
  return Object.fromEntries(
    Object.entries(out)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, [...v].sort()])
  );
}

/** API paths the page calls, with `${...}` collapsed to `:p`. */
export function calledEndpoints(source: string): string[] {
  const out = new Set<string>();
  const re = /(apiGet|apiPost|apiPut|apiDelete)(?:<[^>]*>)?\(\s*([`'])(\/api\/v1[^`']*)\2/g;
  for (let m = re.exec(source); m; m = re.exec(source)) {
    const method = m[1].replace('api', '').toUpperCase();
    const p = m[3].replace(/\$\{[^}]*\}/g, ':p').replace(/\?.*$/, '');
    out.add(`${method} ${p}`);
  }
  return [...out].sort();
}

/** Compound editors the page builder has and the visual panel does not (yet). */
const COMPOUND = new Set(['typography', 'dividers']);

/** Capability ids of the plan (§ 2.1), by field name. Anything not listed maps to P-06. */
const CAPABILITY_BY_FIELD: Record<string, string> = {
  typography: 'P-03',
  dividers: 'P-04',
  scheme: 'P-05',
  density: 'P-05',
  textScale: 'P-05',
};
const CARD_FIELDS =
  /^(showLabel|showHover|showCardFrame|cardFrame\w*|cardSize|cardAspect|cardShape|cardGap|ctaMode|showCardName|showCardPrice|cardImage\w*|productCard\w*)$/;

const SITE_CAPABILITY: Record<string, string> = {
  filterSidebar: 'P-08',
  reviewSection: 'P-09',
  productCardDefaults: 'P-07',
  bottomBar: 'P-11',
  sizing: 'P-12',
};
const siteCapability = (key: string) => SITE_CAPABILITY[key.split('.')[0]] ?? 'P-10';

/**
 * Whole editors of the page builder, found by the component name in its source
 * (a field write is not always an inline `updateSection`): capability id and
 * whether the visual editor already covers it.
 */
const COMPONENTS: Array<{ name: string; capability: string; covered: string | null }> = [
  { name: 'FontsCard', capability: 'P-01', covered: null },
  { name: 'ZoneEditor', capability: 'P-02', covered: null },
  { name: 'SectionTypographyBlock', capability: 'P-03', covered: null },
  { name: 'SectionDividersBlock', capability: 'P-04', covered: null },
  { name: 'DividerStyleSelect', capability: 'P-04', covered: null },
  { name: 'SchemeSelect', capability: 'P-05', covered: null },
  { name: 'DensitySelect', capability: 'P-05', covered: null },
  { name: 'TextScaleSelect', capability: 'P-05', covered: null },
  { name: 'SectionPaddingMaxWidthBlock', capability: 'P-06', covered: null },
  { name: 'KickerSubtitleControls', capability: 'P-06', covered: null },
  { name: 'SectionTitleFields', capability: 'P-06', covered: null },
  { name: 'ProductCardControls', capability: 'P-07', covered: null },
  { name: 'SmartPaletteModal', capability: 'P-13', covered: null },
  { name: 'AiSectionFillButton', capability: 'P-14', covered: null },
  {
    name: 'SlidesEditor',
    capability: 'P-15',
    covered: 'section:hero/blocks (slide) + MediaPicker size hint',
  },
  { name: 'CategoryLayoutButtons', capability: 'P-16', covered: 'section:category-grid/layout' },
  { name: 'NavMenuEditor', capability: 'P-17', covered: 'ChromeContentPanel (header)' },
  { name: 'FooterLinksEditor', capability: 'P-17', covered: 'ChromeContentPanel (footer)' },
  { name: 'ExtraCarouselCard', capability: 'P-18', covered: 'section:product-carousel' },
  { name: 'ManualProductPicker', capability: 'P-18', covered: 'ProductListPicker' },
];

function capabilityFor(field: string): string {
  if (CAPABILITY_BY_FIELD[field]) return CAPABILITY_BY_FIELD[field];
  if (CARD_FIELDS.test(field)) return 'P-07';
  return 'P-06';
}

function settingIds(settings: readonly SettingDefinition[]): Map<string, SettingDefinition> {
  const m = new Map<string, SettingDefinition>();
  for (const s of settings) {
    m.set(s.id, s);
    if (s.localized) m.set(`${s.id}Ar`, s);
  }
  return m;
}

/** Fields the visual editor edits through something that is not a registry setting (blocks, theme). */
const COVERED_ELSEWHERE: Record<string, string> = {
  'hero.slides': 'section:hero/blocks (slide)',
  'trustStrip.items': 'section:trust-strip/blocks (item)',
};

/** The visual editor's own sources (no tests), to see which endpoints it calls. */
function readBuilderSources(): string {
  const out: string[] = [];
  const walkDir = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = path.join(d, name);
      if (statSync(p).isDirectory()) walkDir(p);
      else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name))
        out.push(readFileSync(p, 'utf8'));
    }
  };
  walkDir(path.join(ROOT, 'apps/admin/src/app/stores/[id]/builder'));
  out.push(readFileSync(path.join(ROOT, 'apps/admin/src/lib/page-builder-save.ts'), 'utf8'));
  return out.join('\n');
}

export function buildClassicManifest(): ManifestEntry[] {
  const src = SOURCES.map(f => readFileSync(path.join(DIR, f), 'utf8')).join('\n');
  const entries: ManifestEntry[] = [];

  for (const [legacyKey, fields] of Object.entries(writtenFields(src))) {
    if ((SITE_SETTING_KEYS as readonly string[]).includes(legacyKey)) {
      // A site-wide / page-type setting written through `updateSection`: no visual panel yet.
      for (const field of fields)
        entries.push({
          kind: 'site-setting',
          key: `${legacyKey}.${field}`,
          builder: null,
          status: 'classic-only',
          capability: siteCapability(legacyKey),
          reason: 'siteSettings have no panel in the visual editor',
        });
      continue;
    }
    let def;
    try {
      def = sectionDefinitionForLegacyKey(legacyKey as never);
    } catch {
      def = undefined;
    }
    const ids = def ? settingIds(def.settings) : new Map<string, SettingDefinition>();
    for (const field of fields) {
      const key = `${legacyKey}.${field}`;
      if (COVERED_ELSEWHERE[key]) {
        entries.push({ kind: 'field', key, builder: COVERED_ELSEWHERE[key], status: 'wired' });
        continue;
      }
      // `enabled` is the section's visibility, a document-level flag in the editor.
      if (field === 'enabled' || /^hideOn(Mobile|Tablet|Desktop)$/.test(field)) {
        entries.push({
          kind: 'field',
          key,
          builder: `section:${def?.type ?? legacyKey}/hidden`,
          status: 'wired',
        });
        continue;
      }
      const s = ids.get(field);
      if (s && !COMPOUND.has(s.type)) {
        entries.push({
          kind: 'field',
          key,
          builder: `section:${def!.type}/${field}`,
          status: 'wired',
        });
      } else {
        entries.push({
          kind: 'field',
          key,
          builder: null,
          status: 'classic-only',
          capability: capabilityFor(field),
          reason: s ? 'compound editor not in the visual panel' : 'no registry setting',
        });
      }
    }
  }

  for (const key of SITE_SETTING_KEYS) {
    if (!new RegExp(`\\b(layout\\.${key}|'${key}')\\b`).test(src)) continue;
    entries.push({
      kind: 'site-setting',
      key,
      builder: null,
      status: 'classic-only',
      capability: siteCapability(key),
      reason: 'siteSettings have no panel in the visual editor',
    });
  }

  for (const c of COMPONENTS) {
    if (!new RegExp(`\\b${c.name}\\b`).test(src)) continue;
    entries.push({
      kind: 'component',
      key: c.name,
      builder: c.covered,
      status: c.covered ? 'wired' : 'classic-only',
      capability: c.capability,
      ...(c.covered ? {} : { reason: 'only the form page builder has this editor' }),
    });
  }

  // An endpoint is covered when the visual editor (or the shared save helper) calls it too.
  const builderSrc = readBuilderSources();
  const ENDPOINT_CAPABILITY: Array<[RegExp, string]> = [
    [/ai\/section-content$/, 'P-14'],
    [/uploads\/font$/, 'P-01'],
    [/\/typography$/, 'P-01'],
    [/\/theme$/, 'P-13'],
  ];
  for (const call of calledEndpoints(src)) {
    const path = call.split(' ')[1];
    const tail = path.replace(/:p/g, '').split('/').filter(Boolean).slice(-1)[0];
    if (/layout\/preview$/.test(call)) {
      entries.push({
        kind: 'api',
        key: call,
        builder: null,
        status: 'retired',
        capability: 'P-19',
        reason: 'replaced by the live canvas',
      });
      continue;
    }
    // A live theme / typography write must become a draft write (VE-4), even if the builder also calls it.
    const live = /\/(theme|typography)$/.test(path) || /uploads\/font$/.test(path);
    const used = builderSrc.includes(tail);
    if (used && !live) {
      entries.push({ kind: 'api', key: call, builder: `builder calls ${tail}`, status: 'wired' });
      continue;
    }
    const cap = ENDPOINT_CAPABILITY.find(([re]) => re.test(path))?.[1];
    entries.push({
      kind: 'api',
      key: call,
      builder: null,
      status: 'classic-only',
      ...(cap ? { capability: cap } : {}),
      reason: live
        ? 'writes a live store column; the editor must write the draft'
        : 'the visual editor does not call it yet',
    });
  }

  return entries.sort((a, b) => `${a.kind}|${a.key}`.localeCompare(`${b.kind}|${b.key}`));
}

export const REGISTRY_TYPES = SECTION_REGISTRY.map(d => d.type);
