'use client';

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import { FOCUS_MODE_STORAGE_KEY } from '@/lib/focus-mode-key';

// ─── Types ────────────────────────────────────────────────────────────────────

interface FocusModeState {
  storeId: string;
  /** The admin who entered focus mode. A restore for anyone else is dropped. */
  userId?: string;
}

/**
 * Whether a stored focus state may be restored for `userId` (issue 2253).
 * Clearing the key on logout covered one exit; a session that EXPIRES (a
 * rejected refresh) leaves it behind, and the next admin on the device
 * inherited the previous admin's store. Binding the state to its owner closes
 * every exit at once. A legacy state with no owner cannot be validated, so it
 * is dropped too — re-entering focus mode is one tap.
 */
export function restorableFocusStoreId(
  raw: string | null,
  userId: string | null | undefined
): string | null {
  if (!raw || !userId) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<FocusModeState> | null;
    if (!parsed?.storeId || parsed.userId !== userId) return null;
    return parsed.storeId;
  } catch {
    return null;
  }
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

// `logout()` (lib/auth.tsx) also clears it; the owner check on restore below
// covers every other way a session ends (issue 2253).
export { FOCUS_MODE_STORAGE_KEY };

// ─── Context ──────────────────────────────────────────────────────────────────

const FocusModeContext = createContext<FocusModeContextValue | null>(null);

// ─── Provider ─────────────────────────────────────────────────────────────────

export function FocusModeProvider({ children }: { children: React.ReactNode }) {
  const searchParams = useSearchParams();
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const [focusStoreId, setFocusStoreId] = useState<string | null>(null);

  // On mount: restore from localStorage. If ?focus=1 is present we also
  // honour whatever is already in localStorage (the shortcut just means
  // "stay focused if you already are"). The storeId comes from storage —
  // the URL shortcut doesn't carry a storeId because the manifest
  // start_url is store-agnostic; AdminLayout will redirect once it knows
  // the current storeId.
  useEffect(() => {
    const wantsParam = searchParams?.get('focus') === '1';
    const raw = localStorage.getItem(FOCUS_MODE_STORAGE_KEY);
    const restored = restorableFocusStoreId(raw, userId);
    if (restored) {
      setFocusStoreId(restored);
      return;
    }
    // Another admin's (or an unowned / corrupt) state: never restore it.
    if (raw) localStorage.removeItem(FOCUS_MODE_STORAGE_KEY);

    // ?focus=1 but no stored state: the layout will call enterFocusMode
    // once it resolves a storeId (see AdminLayout's useEffect below).
    // We mark a pending-focus sentinel so AdminLayout can react.
    if (wantsParam) {
      // Store a placeholder so AdminLayout knows to enter focus once it
      // has a storeId. The sentinel value '__pending__' is never used
      // for routing — AdminLayout guards against it.
      setFocusStoreId('__pending__');
    }
    // Run once on mount: the provider mounts only for an authenticated user,
    // so `userId` is already the owner to validate against.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const enterFocusMode = useCallback(
    (storeId: string) => {
      const state: FocusModeState = { storeId, userId: userId ?? undefined };
      localStorage.setItem(FOCUS_MODE_STORAGE_KEY, JSON.stringify(state));
      setFocusStoreId(storeId);
    },
    [userId]
  );

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
