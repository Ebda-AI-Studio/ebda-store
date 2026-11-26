import { describe, it, expect } from 'vitest';
import { returnStatusUpdateTemplate } from '../return-status-update';

// A guest return can be opened by the MERCHANT (admin partial refund / New return) or by the shopper, and the status mail does not
// know which. The copy must never claim "your request" (it would be false for a merchant-opened return): it speaks of
// "the return on your order" instead.
const STATUSES = [
  'approved',
  'rejected',
  'shipped',
  'received',
  'inspecting',
  'completed',
  'cancelled',
  'something_new',
];
const data = (status: string) => ({
  email: 'g@x.com',
  customerName: 'Gus',
  storeName: 'Amelia',
  returnNumber: 'RET-1',
  status,
});

describe('return status update copy is neutral about who opened the return', () => {
  for (const status of STATUSES) {
    it(`en + ar, status ${status}: no "your request" / طلب الإرجاع, names the order`, () => {
      const en = returnStatusUpdateTemplate.en(data(status), 'Amelia');
      const ar = returnStatusUpdateTemplate.ar(data(status), 'Amelia');
      expect(en).not.toMatch(/your (return )?request/i);
      expect(en).toMatch(/your order/i);
      expect(ar).not.toContain('طلب الإرجاع');
      expect(ar).toContain('طلبك');
    });
  }
});
