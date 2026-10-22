'use client';

import { createContext, useContext, type ReactNode } from 'react';
import { getLook } from '@ebda/shared';
import { useCart, type CartItem } from '../../contexts/CartContext';
import { useStore } from '../../contexts/StoreContext';
import { stepperLine } from './card-stepper';

/**
 * Ruling B4-4: whether the cards on this page may turn their add control into a stepper, and the
 * cart lines they read. A store whose look does not set `chrome.cardStepper: 'inline'` provides
 * null, so every card keeps its one add control, byte-identical. The cards read this context, not
 * the store or cart contexts, so a card renders unchanged (and needs no provider) anywhere the
 * provider is not mounted: checkout, tests, marketing captures.
 */
const CardStepperContext = createContext<readonly CartItem[] | null>(null);

export function CardStepperProvider({ children }: { children: ReactNode }) {
  const { store } = useStore();
  const { items } = useCart();
  const on = getLook(store?.look)?.chrome?.cardStepper === 'inline';
  return (
    <CardStepperContext.Provider value={on ? (items ?? []) : null}>
      {children}
    </CardStepperContext.Provider>
  );
}

/** The line a card's stepper drives, or null (no stepper): see `stepperLine`. */
export function useCardStepperLine(
  productId: string,
  opts?: { hasVariants?: boolean }
): CartItem | null {
  const items = useContext(CardStepperContext);
  if (!items || opts?.hasVariants) return null;
  return stepperLine(items, productId);
}
