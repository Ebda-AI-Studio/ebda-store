import { describe, expect, it } from 'vitest';
import { pickAiText } from './ai-text';

describe('pickAiText', () => {
  it('shows the admin language only', () => {
    expect(pickAiText('en', 'Reorder soon', 'اطلب قريبًا')).toEqual({
      text: 'Reorder soon',
      lang: 'en',
    });
    expect(pickAiText('ar', 'Reorder soon', 'اطلب قريبًا')).toEqual({
      text: 'اطلب قريبًا',
      lang: 'ar',
    });
  });
  it('falls back to the other side only when this side is empty', () => {
    expect(pickAiText('en', '', 'اطلب قريبًا')).toEqual({ text: 'اطلب قريبًا', lang: 'ar' });
    expect(pickAiText('ar', 'Reorder soon', null)).toEqual({ text: 'Reorder soon', lang: 'en' });
    expect(pickAiText('en', null, null).text).toBe('');
  });
});

// Defect class (QA 2026-11-23): an admin page rendering one side of an AI text pair raw (or both stacked).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
describe('admin pages render AI text pairs through pickAiText', () => {
  const root = join(__dirname, '..', 'app', 'stores', '[id]');
  it.each([
    ['stock/reorder/page.tsx', /\{item\.reasoning(En|Ar)\}/],
    ['finance/anomalies/page.tsx', /\{item\.explanation(En|Ar)\}/],
    ['finance/dashboard/page.tsx', /\{a\.explanation(En|Ar)\}/],
  ])('%s', (file, rawUse) => {
    const src = readFileSync(join(root, file), 'utf8');
    expect(src).toContain('pickAiText');
    expect(src).not.toMatch(rawUse);
  });
});
