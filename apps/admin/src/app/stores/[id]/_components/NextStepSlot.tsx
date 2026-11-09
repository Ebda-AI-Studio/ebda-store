import type { ReactNode } from 'react';

/**
 * UX:D-5 - one next-step slot at the top of the dashboard. Each child is a card that renders nothing when it has
 * nothing to say (setup guide, order-alerts prompt, stale gold rate), so the first child in the DOM is the first
 * card with something to say; the CSS hides every later one. Order the children by priority.
 */
export function NextStepSlot({ children }: { children: ReactNode }) {
  return (
    <div data-testid="next-step-slot" className="[&>*:not(:first-child)]:hidden">
      {children}
    </div>
  );
}
