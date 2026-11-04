'use client';

import { useCallback, useEffect, useState } from 'react';
import { ConfirmActionModal } from '../components/ConfirmActionModal';
import { useT } from '@/i18n/useT';

export interface ConfirmOptions {
  /** The named thing: "المنتج «قميص أبيض»". Shown as the dialog title. */
  object: string;
  /** One sentence: what happens when the merchant says yes. */
  consequence: string;
  /** Names the outcome: "امسح المنتج", never "تأكيد". */
  confirmLabel: string;
  /** `danger` (default for deletes) paints the confirm button destructive. */
  tone?: 'danger' | 'default';
}

type Pending = ConfirmOptions & { resolve: (ok: boolean) => void };

// One dialog at a time, owned by the <ConfirmHost/> mounted in AdminLayout. A module-level channel (not React
// context) keeps `useConfirm()` usable from any page without a provider wrapper per route.
let current: Pending | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(l => l());

/** Open the dialog. Resolves true on confirm, false on cancel / ESC / backdrop. A second call cancels the first. */
export function requestConfirm(options: ConfirmOptions): Promise<boolean> {
  return new Promise(resolve => {
    current?.resolve(false);
    current = { ...options, resolve };
    emit();
  });
}

/** `const confirm = useConfirm(); if (await confirm({ object, consequence, confirmLabel })) { ... }` */
export function useConfirm(): (options: ConfirmOptions) => Promise<boolean> {
  return useCallback((options: ConfirmOptions) => requestConfirm(options), []);
}

/** Renders the pending confirmation. Mount once (AdminLayout does). */
export function ConfirmHost() {
  const t = useT('components.confirm');
  const [pending, setPending] = useState<Pending | null>(current);

  useEffect(() => {
    const sync = () => setPending(current);
    listeners.add(sync);
    sync();
    return () => {
      listeners.delete(sync);
    };
  }, []);

  const settle = (ok: boolean) => {
    const p = current;
    current = null;
    setPending(null);
    p?.resolve(ok);
  };

  return (
    <ConfirmActionModal
      open={pending !== null}
      title={pending?.object ?? ''}
      description={pending?.consequence ?? ''}
      confirmLabel={pending?.confirmLabel ?? ''}
      cancelLabel={t('cancel')}
      variant={(pending?.tone ?? 'danger') === 'danger' ? 'destructive' : 'default'}
      onConfirm={() => settle(true)}
      onClose={() => settle(false)}
    />
  );
}
