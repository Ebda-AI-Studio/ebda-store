// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('next-intl', () => {
  const t = Object.assign(
    (key: string, values?: Record<string, unknown>) =>
      values ? `${key} ${JSON.stringify(values)}` : key,
    { has: () => true }
  );
  return { useTranslations: () => t, useLocale: () => 'en' };
});

import { ReturnsTable } from './ReturnsTable';
import type { ReturnRecord } from './types';

afterEach(cleanup);

const guestReturn = {
  id: 'r1',
  returnNumber: 'RET-1',
  type: 'return',
  status: 'pending',
  reason: 'size',
  refundAmount: 10000,
  order: { orderNumber: 'ORD-1', total: 336000 },
  customerId: 'guest:o1',
  customer: {
    id: null,
    firstName: 'Mona',
    lastName: 'Ali',
    email: 'm@x.com',
    phone: '+201001234567',
    isGuest: true,
  },
  items: [],
} as unknown as ReturnRecord;

describe('ReturnsTable guest return', () => {
  it("shows the guest's name AND phone from the order, not just a name", () => {
    render(
      <ReturnsTable
        returns={[guestReturn]}
        meta={{ page: 1, limit: 20, total: 1, totalPages: 1 }}
        isLoading={false}
        onSelect={vi.fn()}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onMarkReceived={vi.fn()}
        onComplete={vi.fn()}
        onPageChange={vi.fn()}
      />
    );
    expect(screen.getByText(/Mona Ali/)).toBeTruthy();
    expect(screen.getByText('+201001234567')).toBeTruthy();
  });
});
