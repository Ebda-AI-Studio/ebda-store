// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { PasswordRules } from '../../packages/ui/src/components/PasswordRules';

describe('PasswordRules checklist', () => {
  it('ticks rules as the password gains them, in Arabic and RTL', () => {
    const { container, rerender } = render(<PasswordRules value="" locale="ar" />);
    const met = () =>
      [...container.querySelectorAll('li[data-met="true"]')].map(l => l.getAttribute('data-rule'));
    expect(met()).toEqual([]);
    expect(container.firstElementChild?.getAttribute('dir')).toBe('rtl');
    expect(container.textContent).toContain('حرف إنجليزي كبير (A-Z)');
    rerender(<PasswordRules value="Abcd123!" locale="ar" />);
    expect(met()).toEqual(['length', 'upper', 'lower', 'number', 'special']);
  });

  it('announces progress through a polite live region and never relies on colour alone', () => {
    const { container } = render(<PasswordRules value="abcdefgh" locale="en" />);
    const live = container.querySelector('[aria-live="polite"]');
    expect(live?.textContent).toBe('2 of 5 requirements met');
    expect(container.querySelector('ul')?.getAttribute('aria-labelledby')).toBeTruthy();
    // met rows carry a text status for screen readers, not only the tick colour
    expect(container.querySelector('li[data-rule="length"] .sr-only')?.textContent).toBe('met');
    expect(container.querySelector('li[data-rule="upper"] .sr-only')?.textContent).toBe('not yet');
  });
});
