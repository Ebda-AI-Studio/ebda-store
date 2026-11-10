// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('@/i18n/useT', () => ({ useT: () => (key: string) => key }));

import { StickySaveBar } from './StickySaveBar';
import { ERROR_AR } from '../lib/error-messages';

afterEach(cleanup);

// 2026-11-10 (Ruling ADMIN-ERR-1): a product save answered 500 and the merchant saw only "unsaved changes": the error
// banner sat at the top of a long form, off screen. The bar where Save was pressed now says what happened.
describe('StickySaveBar', () => {
  it('shows the unsaved-changes line while dirty', () => {
    render(<StickySaveBar dirty onSave={() => {}} onReset={() => {}} />);
    expect(screen.getByRole('status').textContent).toBe('dirtyMessage');
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('a failed save shows its Arabic sentence in the bar as an alert', () => {
    render(
      <StickySaveBar dirty onSave={() => {}} onReset={() => {}} error={ERROR_AR.SERVER_ERROR} />
    );
    expect(screen.getByRole('alert').textContent).toBe(ERROR_AR.SERVER_ERROR);
    expect(screen.queryByText('Internal server error')).toBeNull();
  });
});
