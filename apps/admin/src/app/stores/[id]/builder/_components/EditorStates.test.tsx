// @vitest-environment jsdom
/** F63: a skeleton shell while the editor opens, a named error with a retry when it cannot. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('@/i18n/useT', () => ({ useT: () => (k: string) => k }));

import { EditorLoadError, EditorSkeleton } from './EditorStates';

afterEach(cleanup);

describe('editor states', () => {
  it('the skeleton is the editor shell (header, panes, canvas), busy, with the text only for screen readers', () => {
    render(<EditorSkeleton />);
    const sk = screen.getByTestId('editor-skeleton');
    expect(sk.getAttribute('role')).toBe('status');
    expect(sk.getAttribute('aria-busy')).toBe('true');
    expect(sk.querySelectorAll('[class*="animate-pulse"]').length).toBeGreaterThan(8);
    expect(sk.querySelector('.sr-only')?.textContent).toBe('loading');
    expect(sk.className).toContain('h-screen');
  });
  it('the error names the problem, says what to do, and retries', () => {
    const onRetry = vi.fn();
    render(<EditorLoadError onRetry={onRetry} />);
    const card = screen.getByRole('alert');
    expect(card.textContent).toContain('loadErrorTitle');
    expect(card.textContent).toContain('loadErrorHint');
    fireEvent.click(screen.getByRole('button', { name: 'retry' }));
    expect(onRetry).toHaveBeenCalled();
  });
});
