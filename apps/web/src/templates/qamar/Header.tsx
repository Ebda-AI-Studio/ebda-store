'use client';
import { getLook } from '@ebda/shared';
import MinimalHeader from '../minimal/Header';
import type { HeaderProps } from '../types';
import { useStore } from '../../contexts/StoreContext';

/** Qamar chrome (Ruling B1-4): the minimal header with the look's wordmark placement. */
export default function QamarHeader(props: HeaderProps) {
  const { store } = useStore();
  const placement = getLook(store?.look)?.chrome?.header.logoPlacement ?? 'start';
  return <MinimalHeader {...props} logoPlacement={placement} />;
}
