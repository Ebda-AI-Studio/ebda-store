'use client';
import { getLook, resolveHeaderChrome, resolveLockup } from '@ebda/shared';
import MinimalHeader from '../base/Header';
import type { HeaderProps } from '../types';
import { useStore } from '../../contexts/StoreContext';

/**
 * Jasmine chrome (Ruling B3-1): the minimal header, logo-forward. Beauty is bought by trust in
 * the brand, so the wordmark is the sized, untracked display-face one and the search stays the
 * skin's own icon unless the look asks otherwise.
 */
export default function JasmineHeader(props: HeaderProps) {
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
