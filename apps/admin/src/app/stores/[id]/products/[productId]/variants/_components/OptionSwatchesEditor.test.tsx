// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';

const api = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  colorChange: [] as Array<(c: string) => void>,
}));
vi.mock('../../../../../../../lib/api', () => ({ apiGet: api.get, apiPut: api.put }));
vi.mock('@/i18n/useT', () => ({
  useT: () => (k: string, p?: Record<string, string>) => (p ? `${k}:${JSON.stringify(p)}` : k),
}));
vi.mock('@ebda/ui', () => ({
  Button: (p: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...p} />,
  useToast: () => ({ success: api.toastSuccess, error: api.toastError }),
}));
vi.mock('@/components/ImageUpload', () => ({ ImageUpload: () => null }));
vi.mock('@/components/ColorField', () => ({
  ColorField: (p: { onChange: (c: string) => void }) => {
    api.colorChange.push(p.onChange);
    return null;
  },
}));

import { OptionSwatchesEditor } from './OptionSwatchesEditor';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  api.colorChange.length = 0;
});

const options = [
  {
    id: 'o1',
    name: 'Color',
    nameAr: 'اللون',
    position: 0,
    values: [
      { id: 'v1', value: 'Rose', valueAr: 'وردي', position: 0 },
      { id: 'v2', value: 'Sand', valueAr: 'رملي', position: 1 },
    ],
  },
];

describe('OptionSwatchesEditor', () => {
  it('names WHICH value failed in the toast, not a bare count', async () => {
    api.get.mockResolvedValue({ data: { store: { theme: {} } } });
    api.put.mockImplementation(async (url: string) =>
      url.endsWith('/v1') ? { error: 'boom' } : { data: {} }
    );
    render(<OptionSwatchesEditor storeId="s" productId="p" options={options} onSaved={() => {}} />);
    const [rose, sand] = api.colorChange.slice(-2);
    act(() => {
      rose('#aa0000');
      sand('#00aa00');
    });
    await act(async () => {
      fireEvent.click(screen.getByText('swatchesSave'));
    });
    expect(api.toastError).toHaveBeenCalledWith(
      'saveFailedTitle',
      'swatchesFailed:{"values":"Color: Rose"}'
    );
  });

  it('a theme read that resolves after unmount sets no state', async () => {
    let resolve: (v: unknown) => void = () => {};
    api.get.mockReturnValue(new Promise(r => (resolve = r)));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { unmount } = render(
      <OptionSwatchesEditor storeId="s" productId="p" options={options} onSaved={() => {}} />
    );
    unmount();
    await act(async () => resolve({ data: { store: { theme: {} } } }));
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
  });
});
