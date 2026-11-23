'use client';

import { useCallback, useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import {
  actionCountsBySection,
  attentionNavBadges,
  type AttentionItem,
  type AttentionResponse,
} from '@ebda/shared';
import { ATTENTION_REFRESH_EVENT, apiGetQuiet } from '../lib/api';

/**
 * ONE shared "needs attention" feed per store. The sidebar dot, the section badges, the Settings
 * list, the bell and the dashboard tiles all read this hook, so a single request serves them all and
 * they can never disagree.
 *
 * Staleness (NEVER-stale class, server has no cache): refetch on mount, on every route change, on
 * window focus, every 60 s while the tab is visible, and right after any successful write
 * (ATTENTION_REFRESH_EVENT, fired by apiRequest). Requests in flight are shared.
 */
interface Feed {
  items: AttentionItem[];
  loaded: boolean;
}

const EMPTY: Feed = { items: [], loaded: false };
const feeds = new Map<string, Feed>();
const inflight = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();

function publish(storeId: string, feed: Feed) {
  feeds.set(storeId, feed);
  listeners.forEach(l => l());
}

export function refreshAttention(storeId: string): Promise<void> {
  const running = inflight.get(storeId);
  if (running) return running;
  const p = (async () => {
    const { data, error } = await apiGetQuiet<AttentionResponse>(
      `/api/v1/stores/${storeId}/attention`
    );
    // A failed read keeps the last good feed: an unknown state is never rendered as "all clear".
    if (!error && data && Array.isArray(data.items)) {
      publish(storeId, { items: data.items, loaded: true });
    }
  })().finally(() => inflight.delete(storeId));
  inflight.set(storeId, p);
  return p;
}

export function useAttention(storeId: string | null | undefined) {
  const pathname = usePathname();
  const [, force] = useState(0);

  useEffect(() => {
    const l = () => force(n => n + 1);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);

  const refresh = useCallback(() => {
    if (storeId) void refreshAttention(storeId);
  }, [storeId]);

  useEffect(() => {
    refresh();
  }, [refresh, pathname]);

  useEffect(() => {
    if (!storeId) return;
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    const timer = window.setInterval(onVisible, 60_000);
    window.addEventListener('focus', refresh);
    window.addEventListener(ATTENTION_REFRESH_EVENT, refresh);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
      window.removeEventListener(ATTENTION_REFRESH_EVENT, refresh);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [storeId, refresh]);

  const feed = (storeId && feeds.get(storeId)) || EMPTY;
  const actionItems = feed.items.filter(i => i.severity === 'action');
  return {
    items: feed.items,
    loaded: feed.loaded,
    actionCount: actionItems.length,
    bySection: actionCountsBySection(feed.items),
    /** Navigation badges: Orders / Sales from order-money items, Settings from the rest. */
    nav: attentionNavBadges(feed.items),
    /** Any item (action or info) per section, for a quiet marker. */
    hasInfoBySection: feed.items.reduce<Record<string, boolean>>((m, i) => {
      m[i.section] = true;
      return m;
    }, {}),
  };
}
