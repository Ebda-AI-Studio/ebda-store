// @vitest-environment jsdom
/**
 * Tabs and radios in the editor chrome follow the ARIA pattern: arrow keys move + activate, only
 * the active item is a Tab stop, and Left / Right follow the reading direction (Arabic is RTL).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { rovingKeyDown } from './roving';

function Tabs({ dir }: { dir: 'rtl' | 'ltr' }) {
  const [on, setOn] = useState('a');
  return (
    <div dir={dir}>
      <div role="tablist" onKeyDown={e => rovingKeyDown(e, 'tab')}>
        {['a', 'b', 'c'].map(k => (
          <button
            key={k}
            role="tab"
            aria-selected={on === k}
            tabIndex={on === k ? 0 : -1}
            onClick={() => setOn(k)}
          >
            {k}
          </button>
        ))}
      </div>
    </div>
  );
}

afterEach(cleanup);

describe('rovingKeyDown', () => {
  it('LTR: ArrowRight goes forward and activates, End and Home jump', () => {
    render(<Tabs dir="ltr" />);
    screen.getByText('a').focus();
    fireEvent.keyDown(screen.getByText('a'), { key: 'ArrowRight' });
    expect(screen.getByText('b').getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(screen.getByText('b'));
    fireEvent.keyDown(screen.getByText('b'), { key: 'End' });
    expect(screen.getByText('c').getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(screen.getByText('c'), { key: 'Home' });
    expect(screen.getByText('a').getAttribute('aria-selected')).toBe('true');
  });

  it('RTL: ArrowLeft goes forward, ArrowRight goes back (wrapping)', () => {
    render(<Tabs dir="rtl" />);
    screen.getByText('a').focus();
    fireEvent.keyDown(screen.getByText('a'), { key: 'ArrowRight' });
    expect(screen.getByText('c').getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(screen.getByText('c'), { key: 'ArrowLeft' });
    expect(screen.getByText('a').getAttribute('aria-selected')).toBe('true');
  });

  it('only the active tab is a Tab stop', () => {
    render(<Tabs dir="ltr" />);
    expect(screen.getByText('a').tabIndex).toBe(0);
    expect(screen.getByText('b').tabIndex).toBe(-1);
  });
});
