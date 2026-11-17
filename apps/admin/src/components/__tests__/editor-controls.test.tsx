// @vitest-environment jsdom
/**
 * Editor control scale (plan docs/plans/2026-11-15-editor-premium-ux.md, findings F1, F2, F5, F7, F9-F12):
 * the behaviours Ahmad saw broken, as tests that fail when they return. jsdom has no layout engine, so overlap and
 * truncation are asserted as the class/DOM contract that causes them (window-breakpoint grids in a fixed-width
 * pane, `truncate` on labels, side-by-side action rows); the Playwright geometry spec proves them on real layout.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

vi.mock('@/i18n/useT', () => ({
  useT: () =>
    Object.assign(
      (key: string, p?: Record<string, string>) =>
        p ? `${key} ${Object.values(p).join(' ')}` : key,
      { has: () => true }
    ),
}));
vi.mock('../../lib/api', () => ({
  apiFetch: vi.fn(),
  apiGet: vi.fn(),
  localizedApiMessage: (_c: unknown, m: string) => m,
}));

import { Disclosure } from '../ui/Disclosure';
import { Field, Segmented, TextInput } from '../ui/Field';
import { ZoneEditor } from '../ZoneEditor';
import { FontsCard } from '../section-design/FontsCard';
import { FontPicker } from '../section-design/FontPicker';

afterEach(cleanup);

const WINDOW_BP = /(^|\s)(sm|md|lg|xl):(grid-cols|columns)-/;

describe('Disclosure (F7)', () => {
  it('is a button with aria-expanded and aria-controls, no native <details>', () => {
    const { container } = render(
      <Disclosure title="More" testId="d">
        <p>body</p>
      </Disclosure>
    );
    expect(container.querySelector('details,summary')).toBeNull();
    const b = screen.getByRole('button', { name: 'More' });
    expect(b.getAttribute('aria-expanded')).toBe('false');
    const panel = document.getElementById(b.getAttribute('aria-controls')!)!;
    expect(panel.hasAttribute('hidden')).toBe(true);
    fireEvent.click(b);
    expect(b.getAttribute('aria-expanded')).toBe('true');
    expect(panel.hasAttribute('hidden')).toBe(false);
    expect(screen.getByTestId('d').getAttribute('data-state')).toBe('open');
  });

  it('turns its chevron motion off for reduced motion', () => {
    const { container } = render(<Disclosure title="t">x</Disclosure>);
    expect(container.querySelector('svg')!.getAttribute('class')).toContain(
      'motion-reduce:transition-none'
    );
  });
});

describe('Segmented (F5)', () => {
  const opts = [
    { value: 'default', label: 'Default (Sans-serif)' },
    { value: 'rounded', label: 'Rounded (Friendly)' },
  ];
  it('is a radio group; both long options are present and wrap instead of clipping', () => {
    const onChange = vi.fn();
    render(<Segmented label="Font style" value="default" options={opts} onChange={onChange} />);
    const g = screen.getByRole('radiogroup', { name: 'Font style' });
    expect(g.className).toContain('flex-wrap');
    expect(g.className).not.toContain('overflow-hidden');
    expect(screen.getAllByRole('radio').length).toBe(2);
    expect(screen.getByText('Rounded (Friendly)')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Rounded (Friendly)' }));
    expect(onChange).toHaveBeenCalledWith('rounded');
  });
  it('an icon-only option keeps its accessible name', () => {
    render(
      <Segmented
        iconOnly
        label="Align"
        value=""
        onChange={() => {}}
        options={[{ value: '', label: 'Same', icon: <i /> }]}
      />
    );
    expect(screen.getByRole('radio', { name: 'Same' })).toBeTruthy();
  });
});

describe('Field', () => {
  it('shows an error as an alert in place of the hint, label above the control', () => {
    render(
      <Field label="Size" hint="a hint" error="bad size" htmlFor="x">
        <TextInput id="x" />
      </Field>
    );
    expect(screen.getByRole('alert').textContent).toBe('bad size');
    expect(screen.queryByText('a hint')).toBeNull();
    expect(screen.getByLabelText('Size')).toBeTruthy();
  });
});

describe('ZoneEditor in a narrow pane (F2, F12)', () => {
  const mount = (values = {}) =>
    render(
      <ZoneEditor
        zoneKey="header"
        zoneLabel="Header"
        values={values}
        onChange={vi.fn()}
        theme={undefined}
      />
    );

  it('is one column: no window-breakpoint grid anywhere in the editor', () => {
    const { container } = mount();
    const classes = [...container.querySelectorAll('[class]')].map(e => e.getAttribute('class')!);
    expect(classes.filter(c => WINDOW_BP.test(c))).toEqual([]);
  });

  it('size and weight are named options, not free text', () => {
    mount();
    const size = screen.getByRole('radiogroup', { name: 'fontSizeLabel' });
    expect(within(size).getByText('sizeNames.large')).toBeTruthy();
    const weight = screen.getByRole('radiogroup', { name: 'fontWeightLabel' });
    expect(within(weight).getByText('weightNames.bold')).toBeTruthy();
  });

  it('never truncates a label, and the help is not a wall of text', () => {
    const { container } = mount();
    const labels = [...container.querySelectorAll('label, h4')];
    expect(labels.length).toBeGreaterThan(4);
    expect(labels.filter(l => /(^|\s)truncate(\s|$)/.test(l.className))).toEqual([]);
    expect(container.textContent).not.toMatch(/Allowed: 12|Bare number/);
  });

  it('keeps a stored custom size visible and selected instead of losing it', () => {
    mount({ fontSize: '19px' });
    expect(screen.getByRole('radio', { name: '19px' })).toHaveProperty('checked', true);
  });

  it('writes the named choice and shows a live specimen in that style', () => {
    const onChange = vi.fn();
    render(
      <ZoneEditor
        zoneKey="z"
        zoneLabel="Z"
        values={{ fontWeight: '700', fontSize: '22px' }}
        onChange={onChange}
        theme={undefined}
      />
    );
    const spec = screen.getByTestId('zone-specimen');
    expect(spec.style.fontWeight).toBe('700');
    expect(spec.style.fontSize).toBe('22px');
    fireEvent.click(screen.getByRole('radio', { name: 'sizeNames.small' }));
    expect(onChange).toHaveBeenCalledWith({ fontSize: '14px' });
  });

  it('the exact-size field still rejects Tailwind bracket syntax with an inline alert', () => {
    const onChange = vi.fn();
    render(
      <ZoneEditor
        zoneKey="z"
        zoneLabel="Z"
        values={{ fontSize: 'text-[20px]' }}
        onChange={onChange}
        theme={undefined}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'moreOptions' }));
    fireEvent.blur(screen.getByLabelText('exactSizeLabel'));
    expect(onChange).toHaveBeenCalledWith({ fontSize: '' });
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  it('alignment icons mirror in RTL (logical start/end)', () => {
    const { container } = mount();
    const svgs = [
      ...container.querySelectorAll('[role="radiogroup"][aria-label="textAlignmentLabel"] svg'),
    ];
    expect(svgs.some(s => (s.getAttribute('class') ?? '').includes('rtl:-scale-x-100'))).toBe(true);
  });
});

describe('FontsCard actions (F1: the two buttons overlapped)', () => {
  it('stacks "add" and "upload" as two full-width rows, never side by side', () => {
    render(<FontsCard storeId="s" fonts={[]} onChange={vi.fn()} />);
    const actions = screen.getByTestId('fonts-actions');
    expect(WINDOW_BP.test(actions.className)).toBe(false);
    expect(actions.className).toContain('flex-col');
    const buttons = within(actions).getAllByRole('button');
    expect(buttons.length).toBe(2);
    for (const b of buttons) expect(b.className).toContain('w-full');
  });
  it('the add form keeps Cancel and Add in a wrapping row', () => {
    render(<FontsCard storeId="s" fonts={[]} onChange={vi.fn()} />);
    fireEvent.click(screen.getByText('fonts.addGoogleFont'));
    const add = screen.getByText('fonts.addFont');
    expect(add.parentElement!.className).toContain('flex-wrap');
  });
});

describe('FontPicker (F9)', () => {
  const fonts = [
    {
      family: 'Cairo',
      type: 'google' as const,
      url: 'https://fonts.googleapis.com/css2?family=Cairo',
    },
  ];
  it('lists every family in its own face and writes the family name', () => {
    const onChange = vi.fn();
    render(<FontPicker label="Font" value="" fonts={fonts} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Font' }));
    const opt = screen.getByRole('option', { name: /Cairo/ });
    expect((opt.querySelector('button') as HTMLElement).style.fontFamily).toContain('Cairo');
    fireEvent.click(within(opt).getByRole('button'));
    expect(onChange).toHaveBeenCalledWith('Cairo');
  });
  it('keeps a stored family that is not in the library selectable', () => {
    render(<FontPicker label="Font" value="Amiri" fonts={fonts} onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Font' }).textContent).toContain('Amiri');
  });
});
