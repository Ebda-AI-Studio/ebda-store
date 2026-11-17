import { describe, expect, it } from 'vitest';
import { TOOL_SECTIONS, blockReasonFor } from './tool-catalog';
import en from '../../../../../i18n/messages/en.json';
import ar from '../../../../../i18n/messages/ar.json';

describe('blockReasonFor', () => {
  const q = { today: 10, thisMonth: 100, dailyCap: 50, monthlyCap: 500 };
  it('is null while there is allowance left and the switch is on or unknown', () => {
    expect(blockReasonFor(q, true)).toBeNull();
    expect(blockReasonFor(q, null)).toBeNull();
    expect(blockReasonFor(null, null)).toBeNull();
  });
  it('AI switched off wins over everything', () => {
    expect(blockReasonFor({ ...q, today: 50 }, false)).toBe('off');
  });
  it('daily, then monthly, exhaustion', () => {
    expect(blockReasonFor({ ...q, today: 50 }, true)).toBe('daily');
    expect(blockReasonFor({ ...q, thisMonth: 500 }, true)).toBe('monthly');
  });
  it('a cap of 0 is left to the server', () => {
    expect(blockReasonFor({ ...q, dailyCap: 0, today: 5 }, true)).toBeNull();
  });
});

describe('catalog copy', () => {
  const tools = TOOL_SECTIONS.flatMap(s => s.tools);
  it('every tool has a distinct key and endpoint+body', () => {
    expect(new Set(tools.map(x => x.key)).size).toBe(tools.length);
  });
  it.each([
    ['en', en],
    ['ar', ar],
  ] as const)(
    '%s: every card has title, outcome, body, button; every cost class and section has copy',
    (_l, m) => {
      const a = (
        m as unknown as { aiTools: Record<string, Record<string, Record<string, string>>> }
      ).aiTools;
      for (const tool of tools) {
        const c = a.cards[tool.copy];
        for (const k of ['title', 'outcome', 'body', 'button'])
          expect(c?.[k], `${tool.copy}.${k}`).toBeTruthy();
        if (tool.canReplace) expect(c.forceTooltip, `${tool.copy}.forceTooltip`).toBeTruthy();
        expect(a.cost[tool.cost]).toBeTruthy();
      }
      for (const s of TOOL_SECTIONS) {
        expect(a.sections[s.copyKey]).toBeTruthy();
        expect(a.sectionsDesc[s.copyKey]).toBeTruthy();
      }
    }
  );
  it('the page keeps the request shapes: only server-honoured force tools offer replace', () => {
    const noReplace = tools
      .filter(x => !x.canReplace)
      .map(x => x.key)
      .sort();
    expect(noReplace).toEqual(['categorize', 'image-alt', 'translate-ar', 'translate-en']);
  });
});
