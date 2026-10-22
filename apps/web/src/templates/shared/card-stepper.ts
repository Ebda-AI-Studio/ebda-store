import type { CartItem } from '../../contexts/CartContext';

/**
 * Ruling B4-4: the line a card's quantity stepper drives. A stepper only exists for ONE plain line
 * of a non-variant product: no variant (a variant product routes to its page), not flagged
 * unavailable. More than one line of the same product (the same dish with two different notes) is
 * ambiguous, so the card keeps its single add control instead of guessing which line to change.
 */
export function stepperLine(
  items: readonly CartItem[] | undefined,
  productId: string
): CartItem | null {
  if (!items) return null;
  const lines = items.filter(i => i.productId === productId && !i.unavailable);
  if (lines.length !== 1) return null;
  return lines[0].variantId ? null : lines[0];
}
