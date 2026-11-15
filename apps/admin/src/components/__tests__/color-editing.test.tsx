// @vitest-environment jsdom
/**
 * Colour editing (plan findings F3, F4, F11, F14, F17, F18): no CSS in the UI, no fake 1.0 : 1, a keyboard-operable
 * popover with named brand colours, a real preview with a plain verdict, tolerant hex entry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { StoreTheme } from '@ebda/shared';

vi.mock('@/i18n/useT', () => ({
  useT: () =>
    Object.assign(
      (key: string, p?: Record<string, string>) =>
        p ? `${key} ${Object.values(p).join(' ')}` : key,
      { has: () => true }
    ),
}));

import { ColorField } from '../ColorField';
import { ColorContrastPreview } from '../ColorContrastPreview';

const legacy = {} as unknown as StoreTheme; // the row that used to produce "1.0 : 1"

beforeEach(() => {
  const m = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
      setItem: (k: string, v: string) => void m.set(k, String(v)),
      removeItem: (k: string) => void m.delete(k),
      clear: () => m.clear(),
    },
  });
});
afterEach(cleanup);

describe('ColorContrastPreview', () => {
  it('a token missing from a legacy theme is measured against the template default, never 1.0 : 1', () => {
    const { container } = render(<ColorContrastPreview bg="token:primary" theme={legacy} />);
    expect(screen.getByTestId('contrast-preview')).toBeTruthy();
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/1\.0|WCAG|Auto-fixed|autoFixed/);
    expect(text).not.toContain('var(');
    expect(container.querySelector('[data-verdict]')!.getAttribute('data-verdict')).toBe('easy');
  });

  it('says it cannot check an unresolvable colour instead of inventing a number', () => {
    const { container } = render(<ColorContrastPreview bg="hsl(var(--nope))" theme={legacy} />);
    expect(screen.getByTestId('contrast-unknown')).toBeTruthy();
    expect(container.querySelector('[data-verdict]')).toBeNull();
    expect(container.textContent).not.toMatch(/\d : 1|to 1/);
  });

  it('judges the merchant text colour and says so in words', () => {
    const { container } = render(
      <ColorContrastPreview bg="#ffffff" theme={legacy} pickedFg="#eeeeee" />
    );
    expect(container.querySelector('[data-verdict]')!.getAttribute('data-verdict')).toBe('hard');
    expect(container.textContent).toContain('verdict.hard');
    expect(container.textContent).toContain('pickedTextWarning');
  });

  it('keeps the numbers and the hex under Details, closed by default', () => {
    render(<ColorContrastPreview bg="#000000" theme={legacy} />);
    expect(screen.getByTestId('contrast-details').getAttribute('data-state')).toBe('closed');
  });

  it('renders nothing for an empty value', () => {
    const { container } = render(<ColorContrastPreview bg="" theme={legacy} />);
    expect(container.firstChild).toBeNull();
  });
});

describe('ColorField popover', () => {
  const mount = (value: string | undefined, onChange = vi.fn()) => {
    render(<ColorField label="Background" value={value} onChange={onChange} theme={legacy} />);
    return onChange;
  };

  it('shows a plain name and a swatch, never CSS, for a brand colour', () => {
    const { container } = render(
      <ColorField label="Background" value="token:primary" onChange={vi.fn()} theme={legacy} />
    );
    const text = container.textContent ?? '';
    expect(text).toContain('tokens.primary');
    expect(text).not.toMatch(/hsl|var\(|token:/);
  });

  it('opens on click with aria-expanded and offers every brand colour as a named radio', () => {
    mount('');
    const trigger = screen.getByRole('button', { name: /Background/ });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const group = screen.getByRole('radiogroup', { name: 'brandColours' });
    const names = within(group)
      .getAllByRole('radio')
      .map(r => r.textContent);
    expect(names.length).toBe(8);
    expect(names.join(' ')).toContain('tokens.foreground');
  });

  it('choosing a brand colour writes token:<name>; the template colour clears it', () => {
    const onChange = mount('#123456');
    fireEvent.click(screen.getByRole('button', { name: /Background/ }));
    fireEvent.click(screen.getByRole('radio', { name: /tokens\.accent/ }));
    expect(onChange).toHaveBeenLastCalledWith('token:accent');
    fireEvent.click(screen.getByRole('radio', { name: /themeDefaultShort/ }));
    expect(onChange).toHaveBeenLastCalledWith('');
  });

  it('accepts a pasted code with spaces and no #, normalised and remembered as a recent colour', () => {
    const onChange = mount('');
    fireEvent.click(screen.getByRole('button', { name: /Background/ }));
    fireEvent.change(screen.getByLabelText('hexValueAriaLabel'), { target: { value: ' B08D57 ' } });
    expect(onChange).toHaveBeenLastCalledWith('#b08d57');
    expect(window.localStorage.getItem('ebda.colors.recent')).toContain('#b08d57');
  });

  it('flags a code that is not a colour, in words, on blur', () => {
    const onChange = mount('');
    fireEvent.click(screen.getByRole('button', { name: /Background/ }));
    const input = screen.getByLabelText('hexValueAriaLabel');
    fireEvent.change(input, { target: { value: 'zzz' } });
    fireEvent.blur(input);
    expect(screen.getByRole('alert').textContent).toBe('notAColour');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('the trigger is a labelled, focusable button (keyboard: Enter/Space open it)', () => {
    mount('');
    const trigger = screen.getByRole('button', { name: /Background/ });
    expect(trigger.tagName).toBe('BUTTON');
    expect(trigger.getAttribute('aria-controls')).toBeTruthy();
  });
});

describe('hex entry edge cases', () => {
  const type = (text: string) => {
    const onChange = vi.fn();
    render(<ColorField label="Bg" value="" onChange={onChange} theme={legacy} />);
    fireEvent.click(screen.getByRole('button', { name: /Bg/ }));
    fireEvent.change(screen.getByLabelText('hexValueAriaLabel'), { target: { value: text } });
    return onChange;
  };
  it('expands a 3-digit code and drops an alpha pair with a note', () => {
    expect(type('#F0A')).toHaveBeenLastCalledWith('#ff00aa');
    cleanup();
    expect(type('#b08d5780')).toHaveBeenLastCalledWith('#b08d57');
    expect(screen.getByText('alphaIgnored')).toBeTruthy();
  });
  it('rejects a short code without writing it', () => {
    expect(type('#12')).not.toHaveBeenCalled();
  });
});
