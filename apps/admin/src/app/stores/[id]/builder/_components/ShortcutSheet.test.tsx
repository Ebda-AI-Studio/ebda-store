// @vitest-environment jsdom
/**
 * Finding 66: `?` opens a sheet of the editor's real shortcuts. Ignored while typing or when a
 * modal is already open; Escape closes it and focus returns to the opener.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('next-intl', () => {
  const t = Object.assign((key: string) => key, { has: () => true });
  return { useTranslations: () => t, useLocale: () => 'en' };
});

import { ShortcutSheet } from './ShortcutSheet';

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});
afterEach(cleanup);

const press = (target: Element | Window = window, init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(target, { key: '?', shiftKey: true, ...init });

describe('ShortcutSheet', () => {
  it('opens on ? and lists only shortcuts the editor handles', () => {
    render(<ShortcutSheet />);
    expect(screen.queryByTestId('shortcut-sheet')).toBeNull();
    press();
    const sheet = screen.getByTestId('shortcut-sheet');
    expect(sheet.querySelector('dialog, [role=dialog]') ?? sheet).toBeTruthy();
    expect(sheet.querySelectorAll('dt').length).toBe(8);
    expect(sheet.textContent).toContain('Ctrl');
    expect(sheet.querySelectorAll('kbd').length).toBeGreaterThan(8);
  });

  it('ignores ? while typing in a field or editable text', () => {
    render(
      <div>
        <input data-testid="f" />
        <textarea data-testid="ta" />
        <div data-testid="ce" contentEditable suppressContentEditableWarning />
        <ShortcutSheet />
      </div>
    );
    for (const id of ['f', 'ta']) press(screen.getByTestId(id));
    const ce = screen.getByTestId('ce');
    Object.defineProperty(ce, 'isContentEditable', { value: true });
    press(ce);
    expect(screen.queryByTestId('shortcut-sheet')).toBeNull();
  });

  it('ignores ? with a modifier and while another dialog is open', () => {
    const { unmount } = render(<ShortcutSheet />);
    press(window, { ctrlKey: true });
    expect(screen.queryByTestId('shortcut-sheet')).toBeNull();
    unmount();
    const other = document.createElement('dialog');
    other.setAttribute('open', '');
    document.body.appendChild(other);
    render(<ShortcutSheet />);
    press();
    expect(screen.queryByTestId('shortcut-sheet')).toBeNull();
    other.remove();
  });

  it('closes on Escape (cancel) and puts focus back on the opener', () => {
    render(
      <div>
        <button data-testid="opener">x</button>
        <ShortcutSheet />
      </div>
    );
    const opener = screen.getByTestId('opener');
    opener.focus();
    press(opener);
    const sheet = screen.getByTestId('shortcut-sheet');
    fireEvent(sheet, new Event('cancel', { cancelable: true }));
    expect(screen.queryByTestId('shortcut-sheet')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});
