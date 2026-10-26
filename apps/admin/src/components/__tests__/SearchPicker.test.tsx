// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SearchPicker } from '../SearchPicker';

vi.mock('@/i18n/useT', () => ({
  useT: () => (key: string, v?: Record<string, unknown>) =>
    v ? `${key}:${JSON.stringify(v)}` : key,
}));

type Row = { id: string; name: string };
const tick = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function setup(search: (q: string, s: AbortSignal) => Promise<Row[]>, onPick = vi.fn()) {
  render(
    <SearchPicker<Row>
      search={search}
      getKey={r => r.id}
      onPick={onPick}
      placeholder="find"
      renderOption={(r, hl) => <span>{hl(r.name)}</span>}
    />
  );
  return { input: screen.getByRole('combobox'), onPick };
}

describe('SearchPicker', () => {
  it('searches from one Arabic letter, shows highlighted options and picks with the keyboard', async () => {
    vi.useFakeTimers();
    const search = vi.fn(async () => [
      { id: '1', name: 'حذاء' },
      { id: '2', name: 'حقيبة' },
    ]);
    const { input, onPick } = setup(search);
    fireEvent.change(input, { target: { value: 'ح' } });
    await tick(150);
    expect(search).toHaveBeenCalledWith('ح', expect.any(AbortSignal));
    const opts = screen.getAllByRole('option');
    expect(opts).toHaveLength(2);
    expect(opts[0].querySelector('mark')?.textContent).toBe('ح');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toBe(opts[0].id);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onPick).toHaveBeenCalledWith({ id: '2', name: 'حقيبة' });
    expect(screen.queryByRole('option')).toBeNull();
    expect((input as HTMLInputElement).value).toBe(''); // uncontrolled box clears itself
  });

  it('drops a late response for an older query', async () => {
    vi.useFakeTimers();
    const res: Record<string, (r: Row[]) => void> = {};
    const search = (q: string) => new Promise<Row[]>(r => (res[q] = r));
    const { input } = setup(search);
    fireEvent.change(input, { target: { value: 'a' } });
    await tick(150);
    fireEvent.change(input, { target: { value: 'ab' } });
    await tick(150);
    await act(async () => res['ab']([{ id: 'n', name: 'ab new' }]));
    await act(async () => res['a']([{ id: 'o', name: 'a OLD' }]));
    expect(screen.getAllByRole('option').map(o => o.textContent)).toEqual(['ab new']);
  });

  it('shows empty and error states', async () => {
    vi.useFakeTimers();
    let fail = false;
    const search = vi.fn(async () => {
      if (fail) throw new Error('x');
      return [] as Row[];
    });
    const { input } = setup(search);
    fireEvent.change(input, { target: { value: 'zz' } });
    await tick(150);
    expect(screen.getAllByText(/empty/).length).toBeGreaterThan(0);
    fail = true;
    fireEvent.change(input, { target: { value: 'zzz' } });
    await tick(150);
    expect(screen.getAllByText('error').length).toBeGreaterThan(0);
  });
});
