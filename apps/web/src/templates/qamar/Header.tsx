'use client';
import { getLook, resolveHeaderChrome, resolveLockup } from '@ebda/shared';
import MinimalHeader from '../base/Header';
import type { HeaderProps } from '../types';
import { useStore } from '../../contexts/StoreContext';

/**
 * Qamar chrome (Ruling B1-4): the minimal header with the wordmark placement: the merchant's
 * override, else the look's (Ruling EP-4).
 */
export default function QamarHeader(props: HeaderProps) {
  const { store } = useStore();
  const { logoPlacement: placement } = resolveHeaderChrome(
    store?.theme,
    getLook(store?.look)?.chrome?.header
  );
  // The composed theme's wordmark size: merchant > look > skin (W2a T-01).
  return (
    <MinimalHeader
      {...props}
      lockup={resolveLockup(store?.theme, store?.look, store?.template)}
      logoPlacement={placement}
      wordmarkSize={store?.theme?.wordmarkSize}
    />
  );
}
