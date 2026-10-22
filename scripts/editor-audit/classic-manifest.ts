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
  MOBILE_PROP_LEGACY_NAME,
  PAGE_KINDS,
  PAGE_SETTINGS,
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

/**
 * The part of an endpoint path to look for in source: whatever follows the last `:p` parameter
 * (`/stores/:p/ai/section-content` -> `/ai/section-content`), or the whole path when it has none.
 */
export function endpointFragment(path: string): string {
  const after = path.split(':p').pop() ?? path;
  return after === ''
    ? path
        .split(':p')[0]
        .split('/')
        .slice(-1)
        .map(x => `/${x}`)[0]
    : after;
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

/**
 * The visual editor's page-type settings panel (Task 8e) covers a layout key, or one field of it. Returns the
 * control that does, or null when the panel has none.
 */
export function pageSettingsControl(key: string): string | null {
  const [group, ...path] = key.split('.');
  for (const kind of PAGE_KINDS) {
    const g = PAGE_SETTINGS[kind].find(x => x.key === group);
    if (!g) continue;
    if (path.length === 0) return `page-settings:${kind}/${group}`;
    if (g.settings.some(s => s.id === path.join('.'))) return `page-settings:${kind}/${key}`;
  }
  return null;
}

/** Compound editors the page builder has and the visual panel does not (none left after Task 6). */
const COMPOUND = new Set<string>();

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
  { name: 'FontsCard', capability: 'P-01', covered: 'FontsField (theme pane, a draft edit)' },
  {
    name: 'ZoneEditor',
    capability: 'P-02',
    covered: 'TypographyZonesField (theme pane, a draft edit)',
  },
  {
    name: 'SectionTypographyBlock',
    capability: 'P-03',
    covered: 'SectionTypographyField (typography setting)',
  },
  { name: 'SectionDividersBlock', capability: 'P-04', covered: 'DividersField (dividers setting)' },
  { name: 'DividerStyleSelect', capability: 'P-04', covered: 'DividersField (dividers setting)' },
  {
    name: 'SchemeSelect',
    capability: 'P-05',
    covered: 'PageSettingsPanel (colorScheme, every page)',
  },
  { name: 'DensitySelect', capability: 'P-05', covered: 'PageSettingsPanel (density, every page)' },
  {
    name: 'TextScaleSelect',
    capability: 'P-05',
    covered: 'PageSettingsPanel (textScale, every page)',
  },
  {
    name: 'SectionPaddingMaxWidthBlock',
    capability: 'P-06',
    covered: 'registry settings paddingTop, paddingBottom, maxWidth',
  },
  {
    name: 'KickerSubtitleControls',
    capability: 'P-06',
    covered: 'registry settings kicker, subtitle, dividers',
  },
  { name: 'SectionTitleFields', capability: 'P-06', covered: 'registry settings title, titleAr' },
  {
    name: 'ProductCardControls',
    capability: 'P-07',
    covered: 'PageSettingsPanel (productCardDefaults group, home)',
  },
  {
    name: 'SmartPaletteModal',
    capability: 'P-13',
    covered: 'Smart Palette in the theme pane (a draft edit)',
  },
  {
    name: 'AiSectionFillButton',
    capability: 'P-14',
    covered: 'toolbar aiFill and the settings panel button',
  },
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
  // the shared blocks the builder panels render (fonts, dividers, typography, AI fill)
  walkDir(path.join(ROOT, 'apps/admin/src/components/section-design'));
  out.push(readFileSync(path.join(ROOT, 'apps/admin/src/lib/page-builder-save.ts'), 'utf8'));
  return out.join('\n');
}

export function buildClassicManifest(): ManifestEntry[] {
  const src = SOURCES.map(f => readFileSync(path.join(DIR, f), 'utf8')).join('\n');
  const entries: ManifestEntry[] = [];

  for (const [legacyKey, fields] of Object.entries(writtenFields(src))) {
    if ((SITE_SETTING_KEYS as readonly string[]).includes(legacyKey)) {
      // A site-wide / page-type setting written through `updateSection`: no visual panel yet.
      for (const field of fields) {
        const key = `${legacyKey}.${field}`;
        const control = pageSettingsControl(key);
        entries.push(
          control
            ? {
                kind: 'site-setting',
                key,
                builder: control,
                status: 'wired',
                capability: siteCapability(key),
              }
            : {
                kind: 'site-setting',
                key,
                builder: null,
                status: 'classic-only',
                capability: siteCapability(legacyKey),
                reason: 'no control for this siteSettings field in the page-settings panel',
              }
        );
      }
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
      // `layoutMobile` is the mobile viewport override of `layout` in the document (a per-viewport edit).
      const mobileOf = Object.entries(MOBILE_PROP_LEGACY_NAME[legacyKey] ?? {}).find(
        ([, legacy]) => legacy === field
      )?.[0];
      if (mobileOf && def) {
        entries.push({
          kind: 'field',
          key,
          builder: `section:${def.type}/${mobileOf} (mobile viewport override)`,
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
    const control = pageSettingsControl(key);
    entries.push(
      control
        ? {
            kind: 'site-setting',
            key,
            builder: control,
            status: 'wired',
            capability: siteCapability(key),
          }
        : {
            kind: 'site-setting',
            key,
            builder: null,
            status: 'classic-only',
            capability: siteCapability(key),
            reason: 'no control for this siteSettings key in the page-settings panel',
          }
    );
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
    const tail = endpointFragment(path);
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
    // A live theme / typography write must become a draft write (VE-4): the endpoint is covered when the
    // visual editor carries the same data in the draft document and never calls the endpoint itself.
    const live = /\/(theme|typography)$/.test(path) || /uploads\/font$/.test(path);
    const liveWriteInBuilder = /api(Put|Post)[^;]*\/(theme|typography)\b/.test(builderSrc);
    if (live && !liveWriteInBuilder && !/uploads\/font$/.test(path)) {
      entries.push({
        kind: 'api',
        key: call,
        builder: `PageDefinition.${path.endsWith('/theme') ? 'theme' : 'typography'} (draft, published with the page)`,
        status: 'wired',
      });
      continue;
    }
    const used = builderSrc.includes(tail);
    // an uploaded font file is stored by the shared FontsCard; it is not a write to the store's typography
    if (used && (!live || /uploads\/font$/.test(path))) {
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
