// @vitest-environment jsdom
/**
 * When push is not set up on our side yet, the merchant sees a plain "not available yet" note and a disabled form: never
 * server/env instructions.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock('@ebda/ui', async importOriginal => ({
  ...(await importOriginal<typeof import('@ebda/ui')>()),
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../apps/admin/src/i18n/useT', () => ({ useT: () => (k: string) => k }));
vi.mock('../../apps/admin/src/lib/api', () => ({ apiGet, apiPost: vi.fn(), apiPut: vi.fn() }));

import { BroadcastComposerCard } from '../../apps/admin/src/app/stores/[id]/notifications/_components/BroadcastComposerCard';

afterEach(() => {
  cleanup();
  apiGet.mockReset();
});

describe('BroadcastComposerCard', () => {
  it('push unavailable: note shown, fields and send disabled, no env names', async () => {
    apiGet.mockImplementation(async (url: string) =>
      url.endsWith('/push/status')
        ? { data: { available: false, subscribers: 0 }, error: null }
        : { data: { broadcasts: [] }, error: null }
    );
    const { container } = render(<BroadcastComposerCard storeId="s1" />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toContain('notConfiguredTitle');
    expect((screen.getByText('send') as HTMLButtonElement).closest('button')!.disabled).toBe(true);
    for (const el of Array.from(container.querySelectorAll('input, textarea')))
      expect((el as HTMLInputElement).disabled).toBe(true);
    expect(container.textContent).not.toMatch(/ONESIGNAL|Railway|env/i);
  });

  it('push available: no note', async () => {
    apiGet.mockImplementation(async (url: string) =>
      url.endsWith('/push/status')
        ? { data: { available: true, subscribers: 3 }, error: null }
        : { data: { broadcasts: [] }, error: null }
    );
    render(<BroadcastComposerCard storeId="s1" />);
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
