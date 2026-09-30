'use client';

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';

// ─── Types ────────────────────────────────────────────────────────────────────

interface FocusModeState {
  storeId: string;
}

export interface FocusModeContextValue {
  /** Whether focus mode is currently active on this device. */
  isFocused: boolean;
  /** The store whose orders are locked in view. Null when not focused. */
  focusStoreId: string | null;
  enterFocusMode(storeId: string): void;
  exitFocusMode(): void;
}

// ─── Constants ────────────────────────────────────────────────────────────────

// Exported so `logout()` (lib/auth.tsx) can clear it — a second admin
// signing into the same device otherwise inherited whichever store the
// PREVIOUS admin last focused, with no per-user validation on restore.
export const FOCUS_MODE_STORAGE_KEY = 'fwb_focus_mode';

// ─── Context ──────────────────────────────────────────────────────────────────

const FocusModeContext = createContext<FocusModeContextValue | null>(null);

// ─── Provider ─────────────────────────────────────────────────────────────────

export function FocusModeProvider({ children }: { children: React.ReactNode }) {
  const searchParams = useSearchParams();
  const [focusStoreId, setFocusStoreId] = useState<string | null>(null);

  // On mount: restore from localStorage. If ?focus=1 is present we also
  // honour whatever is already in localStorage (the shortcut just means
  // "stay focused if you already are"). The storeId comes from storage —
  // the URL shortcut doesn't carry a storeId because the manifest
  // start_url is store-agnostic; AdminLayout will redirect once it knows
  // the current storeId.
  useEffect(() => {
    const wantsParam = searchParams?.get('focus') === '1';
    try {
      const raw = localStorage.getItem(FOCUS_MODE_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as FocusModeState;
        if (parsed?.storeId) {
          setFocusStoreId(parsed.storeId);
          return;
        }
      }
    } catch {
      // Corrupt storage — ignore and let user re-enter manually.
      localStorage.removeItem(FOCUS_MODE_STORAGE_KEY);
    }

    // ?focus=1 but no stored state: the layout will call enterFocusMode
    // once it resolves a storeId (see AdminLayout's useEffect below).
    // We mark a pending-focus sentinel so AdminLayout can react.
    if (wantsParam) {
      // Store a placeholder so AdminLayout knows to enter focus once it
      // has a storeId. The sentinel value '__pending__' is never used
      // for routing — AdminLayout guards against it.
      setFocusStoreId('__pending__');
    }
  }, []); // intentionally run once on mount only
  // eslint-disable-next-line react-hooks/exhaustive-deps

  const enterFocusMode = useCallback((storeId: string) => {
    const state: FocusModeState = { storeId };
    localStorage.setItem(FOCUS_MODE_STORAGE_KEY, JSON.stringify(state));
    setFocusStoreId(storeId);
  }, []);

  const exitFocusMode = useCallback(() => {
    localStorage.removeItem(FOCUS_MODE_STORAGE_KEY);
    setFocusStoreId(null);
  }, []);

  const isFocused = focusStoreId !== null && focusStoreId !== '__pending__';

  return (
    <FocusModeContext.Provider
      value={{
        isFocused,
        focusStoreId: isFocused ? focusStoreId : null,
        enterFocusMode,
        exitFocusMode,
      }}
    >
      {children}
    </FocusModeContext.Provider>
  );
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

const defaultFocusModeContext: FocusModeContextValue = {
  isFocused: false,
  focusStoreId: null,
  enterFocusMode: () => {},
  exitFocusMode: () => {},
};

export function useFocusMode(): FocusModeContextValue {
  const ctx = useContext(FocusModeContext);
  return ctx ?? defaultFocusModeContext;
}
