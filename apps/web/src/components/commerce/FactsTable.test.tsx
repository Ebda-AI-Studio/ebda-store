// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';

let lang: 'en' | 'ar' = 'en';
vi.mock('@/contexts/LanguageContext', () => ({
  useLanguage: () => ({
    language: lang,
    isRtl: lang === 'ar',
    t: (en: string, ar: string) => (lang === 'ar' ? ar : en),
  }),
}));

import { FactsTable } from './FactsTable';
import { FactChips } from './FactChips';

afterEach(() => {
  cleanup();
  lang = 'en';
});

const arOnly = { key: '', keyAr: 'الخامة', value: '', valueAr: 'كتان', onCard: true };
const both = { key: 'Origin', keyAr: 'المنشأ', value: 'Egypt', valueAr: 'مصر', onCard: false };

describe('FactsTable', () => {
  it('falls back to arabic under english', () => {
    render(<FactsTable facts={[arOnly]} />);
    expect(screen.getByText('الخامة')).toBeTruthy();
    expect(screen.getByText('كتان')).toBeTruthy();
  });
  it('uses the active language when both exist', () => {
    lang = 'ar';
    render(<FactsTable facts={[both]} />);
    expect(screen.getByText('مصر')).toBeTruthy();
    expect(screen.queryByText('Egypt')).toBeNull();
  });
  it('renders nothing for [] / undefined', () => {
    expect(render(<FactsTable facts={[]} />).container.innerHTML).toBe('');
    cleanup();
    expect(render(<FactsTable facts={undefined} />).container.innerHTML).toBe('');
  });
});

describe('FactChips', () => {
  it('shows only onCard values, max 2, value only', () => {
    const rows = [
      arOnly,
      { ...both, onCard: true },
      { ...both, value: 'Third', valueAr: 'ثالث', onCard: true },
    ];
    render(<FactChips product={{ facts: rows }} />);
    const chips = screen.getAllByTestId('fact-chip');
    expect(chips.map(c => c.textContent)).toEqual(['كتان', 'Egypt']);
  });
  it('renders nothing when nothing is pinned', () => {
    expect(render(<FactChips product={{ facts: [both] }} />).container.innerHTML).toBe('');
    cleanup();
    expect(render(<FactChips product={{}} />).container.innerHTML).toBe('');
  });
});

// IA-15 (independent audit): a closing rule after the last fact, then the next
// block's own top rule 24px below, read as an empty extra row (a double rule).
describe('FactsTable rules (IA-15)', () => {
  it('rules sit between rows and above the first, never after the last', () => {
    const { container } = render(<FactsTable facts={[both, both]} />);
    const dl = container.querySelector('dl')!;
    expect(dl.className).toMatch(/\bdivide-y\b/);
    expect(dl.className).toMatch(/\bborder-t\b/);
    expect(dl.className).not.toMatch(/\bborder-(y|b)\b/);
  });
});
