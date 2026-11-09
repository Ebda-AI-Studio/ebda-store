// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { NextStepSlot } from './NextStepSlot';

describe('NextStepSlot (UX:D-5)', () => {
  it('renders every candidate in priority order and marks all but the first to be hidden', () => {
    const { getByTestId } = render(
      <NextStepSlot>
        <p>setup</p>
        {null}
        <p>alerts</p>
        <p>gold</p>
      </NextStepSlot>
    );
    const slot = getByTestId('next-step-slot');
    expect(Array.from(slot.children).map(c => c.textContent)).toEqual(['setup', 'alerts', 'gold']);
    expect(slot.className).toContain('[&>*:not(:first-child)]:hidden');
  });
});
