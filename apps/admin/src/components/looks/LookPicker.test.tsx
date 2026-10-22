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
    expect(activeTab()).toBe(tabs()[0]);
    // The unbuilt templates (Jasmine, Lamma, Dahab) are not offered.
    for (const name of ['Jasmine', 'Lamma', 'Dahab'])
      expect(screen.queryByRole('tab', { name })).toBeNull();
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
    const current = LOOKS.find(l => l.status === 'designed')!;
    render(<LookPicker value={current.id} onChange={() => {}} locale="en" />);
    expect(activeTab().getAttribute('aria-selected')).toBe('true');
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(1);
    expect(radios[0]!.getAttribute('aria-checked')).toBe('true');
    expect(tabs()).toHaveLength(builtLookTemplates().length + 1);
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

  // Mutation check: flip a designed template to built in the registry and the picker must grow a
  // tab for it with no component edit (this is what makes Souq/Jasmine/Lamma/Dahab appear on ship).
  it('MUTATION: flipping a template to built adds its tab; flipping a built one back removes it', () => {
    const designed = LOOKS.filter(l => l.template === 'jasmine');
    const before = designed.map(l => l.status);
    try {
      (designed[0] as { status: string }).status = 'built';
      render(<LookPicker value={null} onChange={() => {}} locale="en" />);
      expect(screen.getByRole('tab', { name: 'Jasmine' })).toBeTruthy();
      expect(tabs()).toHaveLength(builtLookTemplates().length);
      cleanup();
      (designed[0] as { status: string }).status = 'designed';
      render(<LookPicker value={null} onChange={() => {}} locale="en" />);
      expect(screen.queryByRole('tab', { name: 'Jasmine' })).toBeNull();
    } finally {
      designed.forEach((l, i) => ((l as { status: string }).status = before[i]!));
    }
  });
});
