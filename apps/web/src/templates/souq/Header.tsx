'use client';
import { getLook, resolveHeaderChrome, resolveLockup } from '@ebda/shared';
import MinimalHeader from '../base/Header';
import type { HeaderProps } from '../types';
import { useStore } from '../../contexts/StoreContext';

/**
 * Souq chrome (Ruling B2-1): the minimal header with the look's search placement. A catalogue is
 * found by searching, so `prominent` puts one labelled search field in the header on every
 * viewport; `icon` keeps the skin's own icon search. The wordmark is the sized, untracked
 * display-face one (a many-SKU shop is not an editorial lane): the composed theme's
 * `wordmarkSize` when the merchant or look sets one, `lg` otherwise.
 */
export default function SouqHeader(props: HeaderProps) {
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
