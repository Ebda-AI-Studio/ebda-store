/**
 * Keyboard focus follows the card's one control across the add <-> stepper swap (WCAG 2.4.3, B4 a11y
 * P2-1). The add button unmounts when the line appears (and the stepper when `-` removes it), which
 * drops focus to <body> in a dense grid. The control being left asks for the hand-off ("step" = focus
 * the new `+`, "add" = focus the add button); the one that mounts takes it. The request expires, so a
 * swap that never happens (a failed add) cannot steal focus later.
 */
type Target = 'step' | 'add';
let pending: { id: string; to: Target } | null = null;

export function requestStepperFocus(productId: string, to: Target): void {
  const mine = { id: productId, to };
  pending = mine;
  setTimeout(() => {
    if (pending === mine) pending = null;
  }, 4000);
}

/** True once, for the control that should now take focus. */
export function takeStepperFocus(productId: string, to: Target): boolean {
  if (!pending || pending.id !== productId || pending.to !== to) return false;
  pending = null;
  return true;
}
