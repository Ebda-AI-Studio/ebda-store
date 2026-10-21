// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render, screen, fireEvent, within } from '@testing-library/react';
import { LOOKS, LOOK_TEMPLATES, looksForTemplate, getLook } from '@ebda/shared';
import { LookPicker } from './LookPicker';

vi.mock('../../i18n/useT', () => ({
  useT: () => Object.assign((key: string) => key, { has: () => true }),
}));

afterEach(cleanup);

// Dahab is pinned explicitly: with no value the picker opens on the first template that has a built look.
const DAHAB = looksForTemplate('dahab')[0]!.id;
const tabs = () => screen.getAllByRole('tab');

describe('LookPicker', () => {
  it('renders one tab per template, Dahab first, with the registry labels', () => {
    render(<LookPicker value={DAHAB} onChange={() => {}} locale="en" />);
    expect(screen.getByRole('tablist')).toBeTruthy();
    expect(tabs()).toHaveLength(LOOK_TEMPLATES.length);
    expect(tabs()[0]!.textContent).toBe('Dahab');
    expect(tabs()[0]!.getAttribute('aria-selected')).toBe('true');
  });

  it('with no value the first template that has a built look is active (qamar)', () => {
    render(<LookPicker value={null} onChange={() => {}} locale="en" />);
    const active = tabs().find(t => t.getAttribute('aria-selected') === 'true')!;
    expect(active.textContent).toBe('Qamar');
  });

  it('shows the three looks of the active template with name, forWhom and idea (en)', () => {
    render(<LookPicker value={DAHAB} onChange={() => {}} locale="en" />);
    const looks = looksForTemplate('dahab');
    expect(looks).toHaveLength(3);
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(3);
    for (const l of looks) {
      const card = screen.getByRole('radio', { name: new RegExp(l.name.en) });
      expect(within(card).getByText(l.forWhom.en)).toBeTruthy();
      expect(within(card).getByText(l.idea.en)).toBeTruthy();
    }
  });

  it('renders Arabic copy from the registry and is RTL', () => {
    const { container } = render(<LookPicker value={DAHAB} onChange={() => {}} locale="ar" />);
    expect((container.firstChild as HTMLElement).getAttribute('dir')).toBe('rtl');
    expect(tabs()[0]!.textContent).toBe('دهب');
    const l = looksForTemplate('dahab')[0]!;
    const card = screen.getByRole('radio', { name: new RegExp(l.name.ar) });
    expect(within(card).getByText(l.forWhom.ar)).toBeTruthy();
    expect(within(card).getByText(l.idea.ar)).toBeTruthy();
  });

  it('tabs control a tabpanel that wraps the radiogroup and is labelled by the active tab', () => {
    render(<LookPicker value={DAHAB} onChange={() => {}} locale="en" />);
    const panel = screen.getByRole('tabpanel');
    const active = tabs().find(t => t.getAttribute('aria-selected') === 'true')!;
    expect(active.getAttribute('aria-controls')).toBe(panel.id);
    expect(panel.getAttribute('aria-labelledby')).toBe(active.id);
    expect(within(panel).getByRole('radiogroup')).toBeTruthy();
  });

  it('is LTR in English', () => {
    const { container } = render(<LookPicker value={DAHAB} onChange={() => {}} locale="en" />);
    expect((container.firstChild as HTMLElement).getAttribute('dir')).toBe('ltr');
  });

  it('arrow keys move between tabs and show that template (LTR: ArrowRight = next)', () => {
    render(<LookPicker value={DAHAB} onChange={() => {}} locale="en" />);
    fireEvent.keyDown(tabs()[0]!, { key: 'ArrowRight' });
    expect(tabs()[1]!.getAttribute('aria-selected')).toBe('true');
    expect(tabs()[1]!.textContent).toBe('Qamar');
    const first = looksForTemplate('qamar')[0]!;
    expect(screen.getByRole('radio', { name: new RegExp(first.name.en) })).toBeTruthy();
    fireEvent.keyDown(tabs()[1]!, { key: 'ArrowLeft' });
    expect(tabs()[0]!.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(tabs()[0]!, { key: 'End' });
    expect(tabs()[LOOK_TEMPLATES.length - 1]!.getAttribute('aria-selected')).toBe('true');
  });

  it('in Arabic (RTL) ArrowLeft goes to the next tab', () => {
    render(<LookPicker value={DAHAB} onChange={() => {}} locale="ar" />);
    fireEvent.keyDown(tabs()[0]!, { key: 'ArrowLeft' });
    expect(tabs()[1]!.getAttribute('aria-selected')).toBe('true');
  });

  it('selecting a look calls onChange with its id', () => {
    const onChange = vi.fn();
    render(<LookPicker value={DAHAB} onChange={onChange} locale="en" />);
    fireEvent.keyDown(tabs()[0]!, { key: 'ArrowRight' });
    const l = getLook('qamar.lookbook')!;
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(l.name.en) }));
    expect(onChange).toHaveBeenCalledWith('qamar.lookbook');
  });

  it('opens on the tab of the current value and marks it checked', () => {
    render(<LookPicker value="souq.night" onChange={() => {}} locale="en" />);
    expect(tabs().find(t => t.getAttribute('aria-selected') === 'true')!.textContent).toBe('Souq');
    const l = getLook('souq.night')!;
    expect(
      screen.getByRole('radio', { name: new RegExp(l.name.en) }).getAttribute('aria-checked')
    ).toBe('true');
  });

  it('every look thumbnail has alt text equal to the look name, on every tab', () => {
    const onChange = vi.fn();
    render(<LookPicker value={DAHAB} onChange={onChange} locale="ar" />);
    for (let i = 0; i < LOOK_TEMPLATES.length; i++) {
      fireEvent.click(tabs()[i]!);
      const imgs = screen.getAllByRole('img');
      expect(imgs).toHaveLength(3);
      for (const img of imgs) {
        const look = LOOKS.find(l => l.name.ar === img.getAttribute('alt'));
        expect(look, `alt ${img.getAttribute('alt')}`).toBeTruthy();
        expect(img.getAttribute('src')).toBe(`/looks/${look!.id}.webp`);
      }
    }
  });
});
