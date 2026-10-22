// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render, screen, fireEvent, within } from '@testing-library/react';
import { LOOKS, builtLookTemplates, builtLooks, getLook } from '@ebda/shared';
import { LookPicker } from './LookPicker';

vi.mock('../../i18n/useT', () => ({
  useT: () => Object.assign((key: string) => key, { has: () => true }),
}));

afterEach(cleanup);

const FIRST = builtLookTemplates()[0]!;
const tabs = () => screen.getAllByRole('tab');
const activeTab = () => tabs().find(t => t.getAttribute('aria-selected') === 'true')!;

describe('LookPicker (registry-driven: built templates and looks only)', () => {
  it('renders one tab per BUILT template, in registry order, with the registry labels', () => {
    render(<LookPicker value={null} onChange={() => {}} locale="en" />);
    expect(screen.getByRole('tablist')).toBeTruthy();
    expect(tabs()).toHaveLength(builtLookTemplates().length);
    expect(tabs()[0]!.textContent).toBe('Qamar');
    expect(tabs().map(t => t.textContent)).toContain('Souq');
    expect(tabs().map(t => t.textContent)).toContain('Jasmine');
    expect(tabs().map(t => t.textContent)).toContain('Lamma');
    // Phase B5: Dahab is built, and last (Ruling B5-25: Qamar stays the default first tab).
    expect(tabs().map(t => t.textContent)).toEqual(['Qamar', 'Souq', 'Jasmine', 'Lamma', 'Dahab']);
    expect(activeTab()).toBe(tabs()[0]);
  });

  it('offers only built looks under the active tab', () => {
    render(<LookPicker value={null} onChange={() => {}} locale="en" />);
    const built = builtLooks().filter(l => l.template === FIRST);
    expect(screen.getAllByRole('radio')).toHaveLength(built.length);
    for (const l of built) {
      const card = screen.getByRole('radio', { name: new RegExp(l.name.en) });
      expect(within(card).getByText(l.forWhom.en)).toBeTruthy();
      expect(within(card).getByText(l.idea.en)).toBeTruthy();
    }
  });

  it('renders Arabic copy from the registry and is RTL', () => {
    const { container } = render(<LookPicker value={null} onChange={() => {}} locale="ar" />);
    expect((container.firstChild as HTMLElement).getAttribute('dir')).toBe('rtl');
    const l = builtLooks()[0]!;
    const card = screen.getByRole('radio', { name: new RegExp(l.name.ar) });
    expect(within(card).getByText(l.forWhom.ar)).toBeTruthy();
    expect(within(card).getByText(l.idea.ar)).toBeTruthy();
  });

  it('tabs control a tabpanel that wraps the radiogroup and is labelled by the active tab', () => {
    render(<LookPicker value={null} onChange={() => {}} locale="en" />);
    const panel = screen.getByRole('tabpanel');
    expect(activeTab().getAttribute('aria-controls')).toBe(panel.id);
    expect(panel.getAttribute('aria-labelledby')).toBe(activeTab().id);
    expect(within(panel).getByRole('radiogroup')).toBeTruthy();
  });

  it('is LTR in English', () => {
    const { container } = render(<LookPicker value={null} onChange={() => {}} locale="en" />);
    expect((container.firstChild as HTMLElement).getAttribute('dir')).toBe('ltr');
  });

  it('selecting a look calls onChange with its id', () => {
    const onChange = vi.fn();
    render(<LookPicker value={null} onChange={onChange} locale="en" />);
    const l = getLook('qamar.lookbook')!;
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(l.name.en) }));
    expect(onChange).toHaveBeenCalledWith('qamar.lookbook');
  });

  it('opens on the tab of the current value and marks it checked', () => {
    render(<LookPicker value="qamar.vitrine" onChange={() => {}} locale="en" />);
    expect(activeTab().textContent).toBe('Qamar');
    const l = getLook('qamar.vitrine')!;
    expect(
      screen.getByRole('radio', { name: new RegExp(l.name.en) }).getAttribute('aria-checked')
    ).toBe('true');
  });

  it('an existing store on an unbuilt look still sees it (and only it), but nothing unbuilt is added', () => {
    // Every look is built since Phase B5: flip one back for the check.
    const current = LOOKS.find(l => l.id === 'dahab.giftbox')!;
    const before = current.status;
    (current as { status: string }).status = 'designed';
    try {
      const builtTemplates = builtLookTemplates().length;
      render(<LookPicker value={current.id} onChange={() => {}} locale="en" />);
      expect(activeTab().getAttribute('aria-selected')).toBe('true');
      // The store's own unbuilt look is shown (checked), beside the template's built ones and nothing else.
      const radios = screen.getAllByRole('radio');
      const siblings = builtLooks().filter(l => l.template === current.template);
      expect(radios).toHaveLength(siblings.length + 1);
      expect(radios.filter(r => r.getAttribute('aria-checked') === 'true')).toHaveLength(1);
      expect(
        screen
          .getByRole('radio', { name: new RegExp(current.name.en) })
          .getAttribute('aria-checked')
      ).toBe('true');
      expect(tabs()).toHaveLength(builtTemplates);
    } finally {
      (current as { status: string }).status = before;
    }
  });

  it('every look thumbnail has alt text equal to the look name, on every tab', () => {
    render(<LookPicker value={null} onChange={() => {}} locale="ar" />);
    for (let i = 0; i < tabs().length; i++) {
      fireEvent.click(tabs()[i]!);
      const imgs = screen.getAllByRole('img');
      expect(imgs.length).toBeGreaterThan(0);
      for (const img of imgs) {
        const look = LOOKS.find(l => l.name.ar === img.getAttribute('alt'));
        expect(look, `alt ${img.getAttribute('alt')}`).toBeTruthy();
        expect(look!.status).toBe('built');
        expect(img.getAttribute('src')).toBe(`/looks/${look!.id}.webp`);
      }
    }
  });

  // Mutation check: flip a template's looks back to designed and the picker must lose its tab with no
  // component edit (this is what made Dahab appear when it shipped; Souq, Jasmine and Lamma did the same).
  it('MUTATION: flipping a built template back removes its tab; flipping it to built adds it', () => {
    const dahab = LOOKS.filter(l => l.template === 'dahab');
    const before = dahab.map(l => l.status);
    try {
      dahab.forEach(l => ((l as { status: string }).status = 'designed'));
      render(<LookPicker value={null} onChange={() => {}} locale="en" />);
      expect(screen.queryByRole('tab', { name: 'Dahab' })).toBeNull();
      cleanup();
      (dahab[0] as { status: string }).status = 'built';
      render(<LookPicker value={null} onChange={() => {}} locale="en" />);
      expect(screen.getByRole('tab', { name: 'Dahab' })).toBeTruthy();
      expect(tabs()).toHaveLength(builtLookTemplates().length);
    } finally {
      dahab.forEach((l, i) => ((l as { status: string }).status = before[i]!));
    }
  });
});
