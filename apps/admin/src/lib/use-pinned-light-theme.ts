'use client';

import { useEffect } from 'react';
import { isLightPinnedPath } from './auth-theme';

/** Dark-first unless the person saved `light` — same rule as the dashboard's theme toggle. */
function savedThemeIsDark(): boolean {
  try {
    return localStorage.getItem('admin-theme') !== 'light';
  } catch {
    return true;
  }
}

export function usePinnedLightTheme(): void {
  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove('dark');
    return () => {
      // Leaving to a page outside the signed-out set: give it back the saved theme.
      if (!isLightPinnedPath(window.location.pathname)) {
        root.classList.toggle('dark', savedThemeIsDark());
      }
    };
  }, []);
}
