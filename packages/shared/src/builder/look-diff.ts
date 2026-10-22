/**
 * What a look switch changes, in plain terms (Task 9, Ruling EP-3). A pure comparison of the document
 * before and after `applyTemplateFamily`: the editor shows it in the preview so a merchant sees that
 * their content stays and only the design changes. It never decides anything: the apply path recomputes
 * the document itself, so a report can never differ from what is written.
 */
import { getSectionDefinition } from './registry';
import type { PageDefinition, SectionNode } from './schema';

export interface SectionRef {
  id: string;
  type: string;
}

export interface LookChangeReport {
  /** Sections that exist before and after (their content is the merchant's and is not touched). */
  keptContent: SectionRef[];
  /** Sections the new look brings. */
  added: SectionRef[];
  /** Sections the new look has no place for: they leave the DRAFT (never live), restorable from revisions. */
  droppedFromDraft: SectionRef[];
  /** Kept sections whose design settings change. */
  designChanged: Array<{ section: SectionRef; fields: string[] }>;
  /** Kept sections whose CONTENT settings change. A look must never do this: the list is a guard. */
  contentChanged: Array<{ section: SectionRef; fields: string[] }>;
  /** Look-owned theme keys the switch clears (only with `reset`). */
  themeKeysReset: string[];
}

const ref = (n: SectionNode): SectionRef => ({ id: n.id, type: n.type });
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Whether a settings key is content (the merchant's words and pictures) rather than design. */
function isContentKey(type: string, key: string): boolean {
  const defs = getSectionDefinition(type)?.settings ?? [];
  // a bilingual field `title` also owns `titleAr`
  const base =
    key.endsWith('Ar') && defs.some(d => d.localized && d.id === key.slice(0, -2))
      ? key.slice(0, -2)
      : key;
  return defs.find(d => d.id === base)?.group === 'content';
}

function changedKeys(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)]))
    if (!same(a[k], b[k])) out.push(k);
  return out.sort();
}

export function diffTemplateFamily(
  before: PageDefinition,
  after: PageDefinition,
  themeKeysReset: readonly string[] = []
): LookChangeReport {
  const was = new Map(before.sections.map(n => [n.id, n]));
  const now = new Map(after.sections.map(n => [n.id, n]));
  const report: LookChangeReport = {
    keptContent: [],
    added: [],
    droppedFromDraft: [],
    designChanged: [],
    contentChanged: [],
    themeKeysReset: [...themeKeysReset],
  };
  for (const n of after.sections) {
    const old = was.get(n.id);
    if (!old) {
      report.added.push(ref(n));
      continue;
    }
    report.keptContent.push(ref(n));
    const keys = changedKeys(old.settings, n.settings);
    if (old.hidden !== n.hidden) keys.push('hidden');
    const design = keys.filter(k => k === 'hidden' || !isContentKey(n.type, k));
    const content = keys.filter(k => k !== 'hidden' && isContentKey(n.type, k));
    if (design.length > 0) report.designChanged.push({ section: ref(n), fields: design });
    if (content.length > 0) report.contentChanged.push({ section: ref(n), fields: content });
  }
  for (const n of before.sections) if (!now.has(n.id)) report.droppedFromDraft.push(ref(n));
  return report;
}
