/**
 * Taste re-audit P2-6 (S-04, nothing imitates function): in the cart, "نقبل الدفع عبر [الدفع عند
 * الاستلام]" drew each method in a bordered, 28px chip that read as a button and did nothing.
 * The cart row names the methods as plain muted text; only Dahab's own pill idiom keeps a frame.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('cart accepted-payment row is text, not chips (P2-6)', () => {
  it('the cart item class has no border and no button height', () => {
    const src = readFileSync(
      join(__dirname, '../../apps/web/src/components/AcceptedPaymentBadges.tsx'),
      'utf8'
    );
    // the cart branch of the item class (the dahab branch keeps its pill)
    expect(src).not.toContain('rounded-[var(--radius)] border border-input px-2.5');
    expect(src).toContain("'flex items-center gap-2 text-xs text-muted-foreground'");
  });
});
