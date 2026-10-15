// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('@/i18n/useT', () => ({ useT: () => (key: string) => key }));

import { DeliveryOffDaysField } from './DeliveryOffDaysField';

afterEach(cleanup);

describe('DeliveryOffDaysField', () => {
  it('renders seven chips Saturday-first with the selection pressed', () => {
    render(<DeliveryOffDaysField value={[5]} onChange={() => {}} />);
    const chips = screen.getAllByRole('button');
    expect(chips.map(c => c.textContent)).toEqual([
      'deliveryOffDay6',
      'deliveryOffDay0',
      'deliveryOffDay1',
      'deliveryOffDay2',
      'deliveryOffDay3',
      'deliveryOffDay4',
      'deliveryOffDay5',
    ]);
    expect(chips.filter(c => c.getAttribute('aria-pressed') === 'true')).toHaveLength(1);
    expect(chips[6].getAttribute('aria-pressed')).toBe('true');
  });

  it('toggles a day on and off', () => {
    const onChange = vi.fn();
    const { rerender } = render(<DeliveryOffDaysField value={[5]} onChange={onChange} />);
    fireEvent.click(screen.getByText('deliveryOffDay6'));
    expect(onChange).toHaveBeenLastCalledWith([5, 6]);
    rerender(<DeliveryOffDaysField value={[5, 6]} onChange={onChange} />);
    fireEvent.click(screen.getByText('deliveryOffDay5'));
    expect(onChange).toHaveBeenLastCalledWith([6]);
  });

  it('explains why saving is blocked when all seven are selected', () => {
    const { rerender } = render(<DeliveryOffDaysField value={[5]} onChange={() => {}} />);
    expect(screen.queryByRole('alert')).toBeNull();
    rerender(<DeliveryOffDaysField value={[0, 1, 2, 3, 4, 5, 6]} onChange={() => {}} />);
    expect(screen.getByRole('alert').textContent).toBe('deliveryOffDaysAllOff');
  });
});
