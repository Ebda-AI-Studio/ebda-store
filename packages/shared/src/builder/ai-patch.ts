/**
 * AI patch editing (visual builder Phase 5). The model proposes a STRUCTURED patch, never code:
 * a short list of ops drawn from a closed set, each one a thing the editor's own reducer already
 * does. The patch is Zod-validated here, applied through `reduceDocument` (so every registry
 * invariant still holds), every value is checked against the setting's declared type, and the
 * caller validates the whole resulting document before anything is saved. Nothing in a patch can
 * carry markup, an object, a free key or a foreign id: unknown input is rejected, not coerced.
 *
 * Pure: no I/O, never mutates its input. The merchant sees `changes` (before/after) and applies or
 * rejects; applying goes through the normal draft save, so it is undoable and never publishes.
 */
import { z } from 'zod';
import { reduceDocument, locateSection, type ReduceResult } from './editor/document-reducer';
import { DRAFT_THEME_KEYS, draftThemeSchema } from './theme-draft';
import { SECTION_REGISTRY, getSectionDefinition, sectionAllowedOnPage } from './registry';
import type { SettingDefinition } from './settings-schema';
import type { PageDefinition } from './schema';
import { SECTION_ID_RE } from './schema';

export const AI_PATCH_MAX_OPS = 12;

const KEY_RE = /^[A-Za-z][A-Za-z0-9]{0,39}$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const key = z
  .string()
  .regex(KEY_RE)
  .refine(k => !FORBIDDEN_KEYS.has(k));
const id = z.string().regex(SECTION_ID_RE);
/** Scalars only: a patch value is never an object, an array or markup-bearing structure. */
const scalar = z.union([z.string().max(600), z.number().finite(), z.boolean()]);

export const aiPatchOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('setSectionSetting'), id, key, value: scalar }).strict(),
  z
    .object({ op: z.literal('setBlockSetting'), sectionId: id, blockId: id, key, value: scalar })
    .strict(),
  z.object({ op: z.literal('setSectionHidden'), id, hidden: z.boolean() }).strict(),
  z.object({ op: z.literal('moveSection'), id, toIndex: z.number().int().min(0).max(60) }).strict(),
  z.object({ op: z.literal('removeSection'), id }).strict(),
  z
    .object({
      op: z.literal('addSection'),
      sectionType: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
      presetIndex: z.number().int().min(0).max(10),
      index: z.number().int().min(0).max(60).optional(),
    })
    .strict(),
  z
    .object({ op: z.literal('setTheme'), key, value: z.union([z.string().max(100), z.boolean()]) })
    .strict(),
]);
export type AiPatchOp = z.infer<typeof aiPatchOpSchema>;

export const aiPatchSchema = z
  .object({
    /** One plain sentence per language telling the merchant what the patch does. */
    summaryEn: z.string().max(300),
    summaryAr: z.string().max(300),
    ops: z.array(aiPatchOpSchema).max(AI_PATCH_MAX_OPS),
  })
  .strict();
export type AiPatch = z.infer<typeof aiPatchSchema>;

export type AiPatchRejection =
  | 'NOT_FOUND'
  | 'UNKNOWN_SETTING'
  | 'UNKNOWN_THEME_KEY'
  | 'BAD_VALUE'
  | NonNullable<ReduceResult['rejected']>;

export interface AiPatchChange {
  op: AiPatchOp['op'];
  /** Section (or theme) the change touches. */
  id?: string;
  blockId?: string;
  key?: string;
  before?: unknown;
  after?: unknown;
  /** Human labels from the registry so the diff reads in the merchant's language. */
  labelEn: string;
  labelAr: string;
}

export interface AiPatchResult {
  doc: PageDefinition;
  changes: AiPatchChange[];
  rejected: Array<{ index: number; reason: AiPatchRejection }>;
}

function settingDef(
  defs: readonly SettingDefinition[],
  k: string
): { def: SettingDefinition; ar: boolean } | null {
  for (const d of defs) {
    if (d.id === k) return { def: d, ar: false };
    if (d.localized && `${d.id}Ar` === k) return { def: d, ar: true };
  }
  return null;
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const TOKEN = /^token:[a-zA-Z]+$/;

/** A value is acceptable only if it fits the declared control. */
function valueFits(d: SettingDefinition, v: unknown): boolean {
  switch (d.type) {
    case 'checkbox':
      return typeof v === 'boolean';
    case 'range':
      return (
        typeof v === 'number' &&
        (d.min === undefined || v >= d.min) &&
        (d.max === undefined || v <= d.max)
      );
    case 'select':
      return !!d.options?.some(o => o.value === v);
    case 'color':
      return typeof v === 'string' && (HEX.test(v) || TOKEN.test(v));
    case 'text':
    case 'textarea':
      return typeof v === 'string' && !/[<>]/.test(v);
    // media, links, catalogue refs and compound editors are never set by the model
    default:
      return false;
  }
}

export function applyAiPatch(input: PageDefinition, ops: readonly AiPatchOp[]): AiPatchResult {
  let doc = input;
  const changes: AiPatchChange[] = [];
  const rejected: AiPatchResult['rejected'] = [];
  const reject = (index: number, reason: AiPatchRejection) => rejected.push({ index, reason });

  ops.forEach((op, index) => {
    switch (op.op) {
      case 'setSectionSetting': {
        const at = locateSection(doc, op.id);
        if (!at) return reject(index, 'NOT_FOUND');
        const sd = getSectionDefinition(at.node.type);
        const hit = sd && settingDef(sd.settings, op.key);
        if (!sd || !hit) return reject(index, 'UNKNOWN_SETTING');
        if (!valueFits(hit.def, op.value)) return reject(index, 'BAD_VALUE');
        const r = reduceDocument(doc, {
          type: 'setSectionSetting',
          id: op.id,
          key: op.key,
          value: op.value,
        });
        if (r.rejected) return reject(index, r.rejected);
        changes.push({
          op: op.op,
          id: op.id,
          key: op.key,
          before: at.node.settings[op.key],
          after: op.value,
          labelEn: `${sd.labelEn}: ${hit.def.labelEn}`,
          labelAr: `${sd.labelAr}: ${hit.def.labelAr}`,
        });
        doc = r.doc;
        return;
      }
      case 'setBlockSetting': {
        const at = locateSection(doc, op.sectionId);
        const block = at?.node.blocks?.find(b => b.id === op.blockId);
        if (!at || !block) return reject(index, 'NOT_FOUND');
        const bd = getSectionDefinition(at.node.type)?.blocks.find(b => b.type === block.type);
        const hit = bd && settingDef(bd.settings, op.key);
        if (!bd || !hit) return reject(index, 'UNKNOWN_SETTING');
        if (!valueFits(hit.def, op.value)) return reject(index, 'BAD_VALUE');
        const r = reduceDocument(doc, {
          type: 'setBlockSetting',
          sectionId: op.sectionId,
          blockId: op.blockId,
          key: op.key,
          value: op.value,
        });
        if (r.rejected) return reject(index, r.rejected);
        changes.push({
          op: op.op,
          id: op.sectionId,
          blockId: op.blockId,
          key: op.key,
          before: block.settings[op.key],
          after: op.value,
          labelEn: `${bd.labelEn}: ${hit.def.labelEn}`,
          labelAr: `${bd.labelAr}: ${hit.def.labelAr}`,
        });
        doc = r.doc;
        return;
      }
      case 'setSectionHidden':
      case 'moveSection':
      case 'removeSection':
      case 'addSection': {
        const at = op.op === 'addSection' ? null : locateSection(doc, op.id);
        if (op.op !== 'addSection' && !at) return reject(index, 'NOT_FOUND');
        const r =
          op.op === 'addSection'
            ? reduceDocument(doc, {
                type: 'addSection',
                list: getSectionDefinition(op.sectionType)?.group ?? 'template',
                sectionType: op.sectionType,
                presetIndex: op.presetIndex,
                index: op.index,
              })
            : op.op === 'setSectionHidden'
              ? reduceDocument(doc, { type: 'setSectionHidden', id: op.id, hidden: op.hidden })
              : op.op === 'moveSection'
                ? reduceDocument(doc, { type: 'moveSection', id: op.id, toIndex: op.toIndex })
                : reduceDocument(doc, { type: 'removeSection', id: op.id });
        if (r.rejected) return reject(index, r.rejected);
        const sd = getSectionDefinition(
          at?.node.type ?? (op.op === 'addSection' ? op.sectionType : '')
        );
        changes.push({
          op: op.op,
          id: op.op === 'addSection' ? r.createdId : op.id,
          after:
            op.op === 'setSectionHidden'
              ? op.hidden
              : op.op === 'moveSection'
                ? op.toIndex
                : undefined,
          labelEn: sd?.labelEn ?? '',
          labelAr: sd?.labelAr ?? '',
        });
        doc = r.doc;
        return;
      }
      case 'setTheme': {
        if (!DRAFT_THEME_KEYS.includes(op.key)) return reject(index, 'UNKNOWN_THEME_KEY');
        const next = { ...(doc.theme ?? {}), [op.key]: op.value };
        if (!draftThemeSchema.safeParse(next).success) return reject(index, 'BAD_VALUE');
        changes.push({
          op: op.op,
          key: op.key,
          before: doc.theme?.[op.key],
          after: op.value,
          labelEn: `Theme: ${op.key}`,
          labelAr: `التصميم: ${op.key}`,
        });
        doc = { ...doc, theme: next };
        return;
      }
    }
  });
  return { doc, changes, rejected };
}

/**
 * What the model is allowed to see and touch: section ids/types with the setting keys each declares
 * and their CURRENT scalar values, the section types that can be added, and the editable theme keys.
 * The document holds no buyer data (catalogue references are ids, never customer rows), and long
 * strings are truncated so a merchant's own copy cannot flood the prompt.
 */
export function describeAiPatchContext(doc: PageDefinition) {
  const clip = (v: unknown) => (typeof v === 'string' ? v.slice(0, 80) : v);
  const nodes = [...doc.sectionGroups.header, ...doc.sections, ...doc.sectionGroups.footer];
  return {
    pageKey: doc.pageKey,
    sections: nodes.map(n => {
      const sd = getSectionDefinition(n.type);
      const keys = (sd?.settings ?? []).flatMap(s => (s.localized ? [s.id, `${s.id}Ar`] : [s.id]));
      const current: Record<string, unknown> = {};
      for (const k of keys) {
        const v = n.settings[k];
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
          current[k] = clip(v);
      }
      return {
        id: n.id,
        type: n.type,
        hidden: !!n.hidden,
        settingKeys: keys,
        current,
        blocks: (n.blocks ?? []).map(b => ({ id: b.id, type: b.type })),
      };
    }),
    addableTypes: SECTION_REGISTRY.filter(d => sectionAllowedOnPage(d, doc.pageKey)).map(d => ({
      type: d.type,
      presets: d.presets.length,
    })),
    themeKeys: [...DRAFT_THEME_KEYS],
    theme: Object.fromEntries(
      Object.entries(doc.theme ?? {}).filter(
        ([, v]) => typeof v === 'string' || typeof v === 'boolean'
      )
    ),
  };
}
