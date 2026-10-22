// @vitest-environment jsdom
/**
 * Task 13: a drawer below `lg` traps focus while open, closes on Esc, and returns focus to what
 * opened it. At `lg` and up the panes are plain columns: no trap, Esc does nothing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { useState } from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { useDrawerA11y } from './use-drawer-a11y';

function matchMedia(narrow: boolean) {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('min-width') ? !narrow : false,
    addEventListener() {},
    removeEventListener() {},
  }));
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Harness() {
  const [open, setOpen] = useState(false);
  const ref = React.useRef<HTMLElement>(null);
  useDrawerA11y(ref, open, () => setOpen(false));
  return (
    <div>
      <button data-testid="opener" onClick={() => setOpen(true)}>
        open
      </button>
      <aside ref={ref} hidden={!open} data-testid="drawer">
        <button data-testid="first">1</button>
        <button data-testid="last">2</button>
      </aside>
    </div>
  );
}

describe('useDrawerA11y', () => {
  it('moves focus in, traps Tab, closes on Esc and returns focus to the opener', () => {
    matchMedia(true);
    const { getByTestId } = render(<Harness />);
    const opener = getByTestId('opener');
    opener.focus();
    fireEvent.click(opener);
    expect(document.activeElement).toBe(getByTestId('first'));
    // Tab from the last wraps to the first; Shift+Tab from the first wraps to the last
    getByTestId('last').focus();
    fireEvent.keyDown(getByTestId('last'), { key: 'Tab' });
    expect(document.activeElement).toBe(getByTestId('first'));
    fireEvent.keyDown(getByTestId('first'), { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(getByTestId('last'));
    fireEvent.keyDown(getByTestId('last'), { key: 'Escape' });
    expect(getByTestId('drawer').hasAttribute('hidden')).toBe(true);
    expect(document.activeElement).toBe(opener);
  });

  it('does nothing at lg and up', () => {
    matchMedia(false);
    const { getByTestId } = render(<Harness />);
    const opener = getByTestId('opener');
    opener.focus();
    fireEvent.click(opener);
    expect(document.activeElement).toBe(opener);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(getByTestId('drawer').hasAttribute('hidden')).toBe(false);
  });
});
