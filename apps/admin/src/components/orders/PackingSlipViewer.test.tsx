// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@/i18n/useT', () => ({
  useT: () => (key: string, v?: Record<string, unknown>) =>
    v ? `${key}:${Object.values(v).join(',')}` : key,
}));
vi.mock('next-intl', () => ({ useLocale: () => 'ar' }));
const apiFetch = vi.fn();
vi.mock('../../lib/api', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));

import { PackingSlipViewer } from './PackingSlipViewer';

const ok = (html: string, skipped = '') => ({
  ok: true,
  text: async () => html,
  headers: {
    get: (h: string) => (h.toLowerCase() === 'x-packing-slips-skipped' && skipped ? skipped : null),
  },
});
const O1 = '11111111-1111-4111-8111-111111111111';
const O2 = '22222222-2222-4222-8222-222222222222';

afterEach(() => {
  cleanup();
  apiFetch.mockReset();
});

describe('PackingSlipViewer', () => {
  it('single order: GET with A4 + the admin locale, shows the slip in a sandboxed frame', async () => {
    apiFetch.mockResolvedValue(ok('<html><body>slip</body></html>'));
    const { container } = render(<PackingSlipViewer storeId="s1" orderIds={[O1]} />);
    await waitFor(() => expect(container.querySelector('iframe')).toBeTruthy());
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/v1/stores/s1/orders/' + O1 + '/packing-slip?size=a4&locale=ar'
    );
    const frame = container.querySelector('iframe')!;
    expect(frame.getAttribute('srcdoc')).toContain('slip');
    expect(frame.getAttribute('sandbox')).toBe('allow-same-origin allow-modals');
  });
  it('size toggle reloads at 4x6 label', async () => {
    apiFetch.mockResolvedValue(ok('<html>x</html>'));
    render(<PackingSlipViewer storeId="s1" orderIds={[O1]} />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('radio', { name: 'sizeLabel' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
    expect(apiFetch.mock.calls[1]![0]).toContain('size=label');
  });
  it('bulk: POST with the ids, size and locale', async () => {
    apiFetch.mockResolvedValue(ok('<html>x</html>'));
    render(<PackingSlipViewer storeId="s1" orderIds={[O1, O2]} />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    const [url, init] = apiFetch.mock.calls[0]!;
    expect(url).toBe('/api/v1/stores/s1/orders/packing-slips');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ orderIds: [O1, O2], size: 'a4', locale: 'ar' });
  });
  it('bulk: tells how many orders were skipped (not in this store / deleted)', async () => {
    apiFetch.mockResolvedValue(ok('<html>x</html>', `${O2}`));
    render(<PackingSlipViewer storeId="s1" orderIds={[O1, O2]} />);
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('skipped:1'));
  });
  it('no skipped orders: no notice', async () => {
    apiFetch.mockResolvedValue(ok('<html>x</html>'));
    const { container } = render(<PackingSlipViewer storeId="s1" orderIds={[O1, O2]} />);
    await waitFor(() => expect(container.querySelector('iframe')).toBeTruthy());
    expect(screen.queryByRole('status')).toBeNull();
  });
  it('more than 100 orders is refused before any request', () => {
    const many = Array.from(
      { length: 101 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
    );
    render(<PackingSlipViewer storeId="s1" orderIds={many} />);
    expect(screen.getByRole('alert').textContent).toBe('tooMany');
    expect(apiFetch).not.toHaveBeenCalled();
  });
  it('a failed load says so (no frame, print disabled)', async () => {
    apiFetch.mockResolvedValue({ ok: false, status: 403, text: async () => '' });
    const { container } = render(<PackingSlipViewer storeId="s1" orderIds={[O1]} />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('loadFailed'));
    expect(container.querySelector('iframe')).toBeNull();
    expect((screen.getByText('print') as HTMLButtonElement).disabled).toBe(true);
  });
});
