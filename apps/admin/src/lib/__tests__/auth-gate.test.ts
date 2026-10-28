import { describe, it, expect } from 'vitest';
import { shouldRenderShell } from '../auth-gate';

describe('shouldRenderShell', () => {
  it('never paints a protected page while the session is unknown', () => {
    expect(shouldRenderShell({ isLoading: true, hasUser: false, isPublic: false })).toBe(false);
  });
  it('never paints a protected page for a logged-out visitor (the dashboard flash)', () => {
    expect(shouldRenderShell({ isLoading: false, hasUser: false, isPublic: false })).toBe(false);
  });
  it('paints a protected page once a user is known', () => {
    expect(shouldRenderShell({ isLoading: false, hasUser: true, isPublic: false })).toBe(true);
  });
  it('always paints public pages, even while loading', () => {
    expect(shouldRenderShell({ isLoading: true, hasUser: false, isPublic: true })).toBe(true);
    expect(shouldRenderShell({ isLoading: false, hasUser: false, isPublic: true })).toBe(true);
  });
});
