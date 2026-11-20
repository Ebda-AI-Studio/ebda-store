'use client';

import { useCallback, useState } from 'react';
import { useToast } from '@ebda/ui';
import { apiPost } from '@/lib/api';

export const SCAN_POLL_MS = 3000;
export const SCAN_MAX_POLLS = 10;

/**
 * QA-117: a "scan now" button POSTs a job that answers 202 and runs in the background. Polls `reload` (which returns the
 * newest scan stamp) until it differs from `before`, up to `maxPolls` tries. True = a new scan landed.
 */
export async function pollForNewStamp(opts: {
  reload: () => Promise<string | null>;
  before: string | null;
  wait: (ms: number) => Promise<void>;
  maxPolls?: number;
  intervalMs?: number;
}): Promise<boolean> {
  const { reload, before, wait, maxPolls = SCAN_MAX_POLLS, intervalMs = SCAN_POLL_MS } = opts;
  for (let i = 0; i < maxPolls; i++) {
    await wait(intervalMs);
    const now = await reload();
    if (now && now !== before) return true;
  }
  return false;
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** Shared by the stock scan pages. `t` reads the page's namespace: scanQueued, scanDone, scanNoChange, scanFailed. */
export function useQueuedScan(opts: {
  path: string;
  /** Silent refresh of the list; resolves to the newest scan stamp (or null). */
  reload: () => Promise<string | null>;
  currentStamp: string | null;
  t: (k: string) => string;
}) {
  const { path, reload, currentStamp, t } = opts;
  const toast = useToast();
  const [running, setRunning] = useState(false);

  const start = useCallback(async () => {
    if (running) return;
    setRunning(true);
    try {
      const { error } = await apiPost(path, {});
      if (error) {
        toast.error(t('scanFailed'), error.message || '');
        return;
      }
      toast.info(t('scanQueued'));
      const landed = await pollForNewStamp({ reload, before: currentStamp, wait: sleep });
      if (landed) toast.success(t('scanDone'));
      else toast.info(t('scanNoChange'));
    } finally {
      setRunning(false);
    }
  }, [running, path, reload, currentStamp, t, toast]);

  return { running, start };
}
