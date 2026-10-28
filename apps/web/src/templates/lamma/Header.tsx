'use client';
import { getLook, resolveHeaderChrome, resolveLockup } from '@ebda/shared';
import MinimalHeader from '../base/Header';
import type { HeaderProps } from '../types';
import { useStore } from '../../contexts/StoreContext';

/**
 * Lamma chrome (Ruling B4-1): the minimal header with the look's logo placement. A home cook's
 * name is the brand, so the wordmark is the sized display-face one; the search stays the skin's
 * own icon. The browse cart bar (Ruling B4-6) is mounted by the layout, not here.
 */
export default function LammaHeader(props: HeaderProps) {
  const { store } = useStore();
  const chrome = resolveHeaderChrome(store?.theme, getLook(store?.look)?.chrome?.header);
  return (
    <MinimalHeader
      {...props}
      lockup={resolveLockup(store?.theme, store?.look, store?.template)}
      logoPlacement={chrome.logoPlacement}
      wordmarkSize={store?.theme?.wordmarkSize ?? 'lg'}
      searchPlacement={chrome.search}
    />
  );
}
