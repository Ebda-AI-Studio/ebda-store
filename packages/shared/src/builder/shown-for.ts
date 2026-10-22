/**
 * Pure visibility of an editor control (Ruling EP-1). One function for the settings panel, the
 * audit matrix and the tests, so "shown" means the same thing everywhere.
 */
import type { ShownFor, ShownRule } from './settings-schema';
import type { SectionDefinition } from './registry';
import type { SectionNode } from './schema';
import { VIEWPORTS } from './viewports';

export interface ShownContext {
  /** The store's resolved template (skin). Unknown / legacy ids match no `templates` rule. */
  template?: string | null;
  look?: string | null;
  /**
   * Every effective value of a variant key on the section being edited (the desktop value and
   * the mobile override, e.g. `layout` and `layoutMobile`). Omit it and a `variants` rule is
   * taken as satisfied: a caller that has no section in hand never hides a control.
   */
  variant?: (key: string) => readonly unknown[];
}

export const rulesOf = (shownFor: ShownFor | undefined): readonly ShownRule[] =>
  shownFor === undefined ? [] : Array.isArray(shownFor) ? shownFor : [shownFor as ShownRule];

/** Does one rule hold for the template and look alone (variants are checked separately)? */
export function ruleMatchesStore(rule: ShownRule, ctx: Pick<ShownContext, 'template' | 'look'>) {
  if (rule.templates && !(ctx.template && rule.templates.includes(ctx.template as never)))
    return false;
  if (rule.looks && !(ctx.look && rule.looks.includes(ctx.look))) return false;
  return true;
}

export function isShown(d: { shownFor?: ShownFor }, ctx: ShownContext = {}): boolean {
  const rules = rulesOf(d.shownFor);
  if (rules.length === 0) return true;
  return rules.some(rule => {
    if (!ruleMatchesStore(rule, ctx)) return false;
    if (!rule.variants || !ctx.variant) return true;
    return Object.entries(rule.variants).every(([key, allowed]) =>
      ctx.variant!(key).some(v => allowed.includes(v as never))
    );
  });
}

/**
 * `ShownContext.variant` for a section in a document: the key's value on the section, on each
 * viewport override (`responsive.<viewport>.settings`), and the registry's default preset when
 * the document stores none, so a section nobody touched answers with the value it renders with.
 */
export function sectionVariants(
  def: Pick<SectionDefinition, 'presets'>,
  node: Pick<SectionNode, 'settings' | 'responsive'>
): NonNullable<ShownContext['variant']> {
  return key => {
    const values: unknown[] = [];
    const own = node.settings[key];
    if (own !== undefined) values.push(own);
    for (const v of VIEWPORTS) {
      const o = node.responsive?.[v]?.settings?.[key];
      if (o !== undefined) values.push(o);
    }
    if (own === undefined) {
      const preset = def.presets[0]?.settings?.[key];
      if (preset !== undefined) values.push(preset);
    }
    return values;
  };
}
