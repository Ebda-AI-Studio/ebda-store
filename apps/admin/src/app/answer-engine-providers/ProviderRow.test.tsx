// @vitest-environment jsdom
/**
 * Regression for #909: the save route wraps its response as
 * `{ success: true, data: { config } }`, but the client called
 * `apiPut<ProviderConfig>(...)` (the WRONG generic — apiRequest already
 * unwraps one `data` level, so the resolved value is `{ config }`, not
 * `ProviderConfig`) and passed that straight to `onSaved(data)`. The row's
 * merge (`c.engine === next.engine`) then compared against `undefined`
 * (the wrapped object has no top-level `.engine`), never matched, and the
 * row silently never refreshed after a successful save.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ProviderRow, type ProviderConfig } from './page';

const putMock = vi.fn();

vi.mock('../../lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('../../lib/api')>();
  return {
    ...actual,
    apiPut: (...args: unknown[]) => putMock(...args),
    apiGet: vi.fn(),
  };
});

vi.mock('../../i18n/useT', () => ({
  useT: () => Object.assign((key: string) => key, { has: () => true }),
}));

afterEach(() => {
  cleanup();
  putMock.mockReset();
});

const BASE_CONFIG: ProviderConfig = {
  engine: 'perplexity',
  enabled: false,
  apiKeyMasked: null,
};

describe('ProviderRow save (#909)', () => {
  it('unwraps the { config } envelope before calling onSaved — passes the ProviderConfig, not the wrapper', async () => {
    putMock.mockResolvedValue({
      data: { config: { ...BASE_CONFIG, enabled: true } },
      error: null,
    });
    const onSaved = vi.fn();

    render(<ProviderRow config={BASE_CONFIG} onSaved={onSaved} />);
    fireEvent.click(screen.getByText('saveButton'));

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));

    const arg = onSaved.mock.calls[0][0];
    // The defect: onSaved was called with { config: {...} } — no top-level
    // `engine`, so a caller matching `c.engine === next.engine` never finds
    // a match and silently no-ops.
    expect(arg.engine).toBe('perplexity');
    expect(arg.enabled).toBe(true);
    expect(arg.config).toBeUndefined();
  });
});
