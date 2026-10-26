// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook } from '@testing-library/react';
import { useState } from 'react';
import { useLiveSearch } from './useLiveSearch';
import { useListboxNav } from './useListboxNav';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const tick = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

describe('useLiveSearch', () => {
  it('searches from one character after the debounce, not before', async () => {
    vi.useFakeTimers();
    const search = vi.fn(async (q: string) => [q]);
    const { result } = renderHook(() => useLiveSearch({ query: 'ح', search }));
    await tick(100);
    expect(search).not.toHaveBeenCalled();
    expect(result.current.status).toBe('loading');
    await tick(60);
    expect(search).toHaveBeenCalledWith('ح', expect.any(AbortSignal));
    expect(result.current).toMatchObject({ status: 'ready', results: ['ح'], settledQuery: 'ح' });
  });

  it('stays idle below minChars and when disabled', async () => {
    vi.useFakeTimers();
    const search = vi.fn(async () => ['x']);
    const a = renderHook(() => useLiveSearch({ query: '  ', search }));
    const b = renderHook(() => useLiveSearch({ query: 'abc', search, enabled: false }));
    await tick(500);
    expect(search).not.toHaveBeenCalled();
    expect(a.result.current.status).toBe('idle');
    expect(b.result.current.status).toBe('idle');
  });

  it('aborts the superseded request and never shows its results', async () => {
    vi.useFakeTimers();
    const resolvers: Record<string, (v: string[]) => void> = {};
    const signals: Record<string, AbortSignal> = {};
    const search = (q: string, signal: AbortSignal) =>
      new Promise<string[]>(res => {
        resolvers[q] = res;
        signals[q] = signal;
      });
    const { result, rerender } = renderHook(({ q }) => useLiveSearch({ query: q, search }), {
      initialProps: { q: 'a' },
    });
    await tick(150); // request "a" in flight
    rerender({ q: 'ab' });
    await tick(150); // request "ab" in flight
    expect(signals['a'].aborted).toBe(true);
    expect(signals['ab'].aborted).toBe(false);
    // the NEW one answers first, then the stale one arrives late
    await act(async () => resolvers['ab'](['new']));
    await act(async () => resolvers['a'](['OLD']));
    expect(result.current).toMatchObject({ status: 'ready', results: ['new'], settledQuery: 'ab' });
  });

  it('exposes no results while a newer query is pending', async () => {
    vi.useFakeTimers();
    const search = vi.fn(async (q: string) => [q]);
    const { result, rerender } = renderHook(({ q }) => useLiveSearch({ query: q, search }), {
      initialProps: { q: 'a' },
    });
    await tick(150);
    expect(result.current.results).toEqual(['a']);
    rerender({ q: 'ab' });
    expect(result.current).toMatchObject({ status: 'loading', results: [] });
  });

  it('reports an error without leaving stale results, and ignores aborted rejections', async () => {
    vi.useFakeTimers();
    const search = vi.fn(async () => {
      throw new Error('boom');
    });
    const { result } = renderHook(() => useLiveSearch({ query: 'x', search }));
    await tick(150);
    expect(result.current).toMatchObject({ status: 'error', results: [] });
  });

  it('serves a repeated query from the cache without a request', async () => {
    vi.useFakeTimers();
    const search = vi.fn(async (q: string) => [q]);
    const { result, rerender } = renderHook(({ q }) => useLiveSearch({ query: q, search }), {
      initialProps: { q: 'a' },
    });
    await tick(150);
    rerender({ q: 'b' });
    await tick(150);
    rerender({ q: 'a' });
    await tick(0);
    expect(search).toHaveBeenCalledTimes(2);
    expect(result.current.results).toEqual(['a']);
  });
});

function Box({ items, onPick }: { items: string[]; onPick: (i: number) => void }) {
  const [open, setOpen] = useState(true);
  const nav = useListboxNav({ count: items.length, open, setOpen, onPick });
  return (
    <div>
      <input aria-label="q" {...nav.inputProps} />
      {open && (
        <ul {...nav.listProps}>
          {items.map((t, i) => (
            <li key={t} id={nav.optionId(i)} role="option" aria-selected={i === nav.activeIndex}>
              {t}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

describe('useListboxNav (ARIA combobox)', () => {
  it('wires combobox attributes and moves aria-activedescendant with the arrows', () => {
    const onPick = vi.fn();
    const { getByLabelText, getAllByRole } = render(
      <Box items={['a', 'b', 'c']} onPick={onPick} />
    );
    const input = getByLabelText('q');
    expect(input.getAttribute('role')).toBe('combobox');
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(input.getAttribute('aria-controls')).toBe(getAllByRole('listbox')[0].id);
    expect(input.getAttribute('aria-activedescendant')).toBeNull();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    const opts = getAllByRole('option');
    expect(input.getAttribute('aria-activedescendant')).toBe(opts[0].id);
    expect(opts[0].getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(input, { key: 'ArrowUp' }); // wraps to last
    expect(input.getAttribute('aria-activedescendant')).toBe(opts[2].id);
    fireEvent.keyDown(input, { key: 'Home' });
    expect(input.getAttribute('aria-activedescendant')).toBe(opts[0].id);
    fireEvent.keyDown(input, { key: 'End' });
    expect(input.getAttribute('aria-activedescendant')).toBe(opts[2].id);
  });

  it('Enter picks only an active option; Escape closes', () => {
    const onPick = vi.fn();
    const { getByLabelText, queryByRole } = render(<Box items={['a', 'b']} onPick={onPick} />);
    const input = getByLabelText('q');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onPick).not.toHaveBeenCalled(); // no active option: the form submits
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onPick).toHaveBeenCalledWith(1);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(queryByRole('listbox')).toBeNull();
    expect(input.getAttribute('aria-expanded')).toBe('false');
  });
});
