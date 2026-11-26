// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import en from '../i18n/messages/en.json';
import ar from '../i18n/messages/ar.json';

vi.mock('@/i18n/useT', () => ({
  useT: () => (k: string, v?: Record<string, unknown>) => (v ? `${k}|${v.position}` : k),
}));

import { useDndA11y } from './useDndA11y';

describe('useDndA11y (E1)', () => {
  const { accessibility } = renderHook(() => useDndA11y()).result.current;
  const over = (index: number) => ({ id: 'x', data: { current: { sortable: { index } } } });

  it('uses the translated instructions, not the dnd-kit English default', () => {
    expect(accessibility.screenReaderInstructions.draggable).toBe('instructions');
    expect(accessibility.screenReaderInstructions.draggable).not.toMatch(/space bar/i);
  });
  it('announces positions (1-based), never ids', () => {
    const a = accessibility.announcements;
    expect(a.onDragStart({ active: { id: 'uuid-1' } } as never)).toBe('pickedUp');
    expect(a.onDragOver!({ active: { id: 'u' }, over: over(1) } as never)).toBe('movedOver|2');
    expect(a.onDragEnd!({ active: { id: 'u' }, over: over(2) } as never)).toBe('dropped|3');
    expect(a.onDragEnd!({ active: { id: 'u' }, over: null } as never)).toBe('droppedBack');
    expect(a.onDragCancel!({ active: { id: 'u' } } as never)).toBe('cancelled');
  });
  it('has EN and Egyptian AR copy for every key it uses, with no Latin dnd-kit leftovers in AR', () => {
    const keys = ['instructions', 'pickedUp', 'movedOver', 'dropped', 'droppedBack', 'cancelled'];
    for (const k of keys) {
      expect((en.common.dndA11y as Record<string, string>)[k]).toBeTruthy();
      expect((ar.common.dndA11y as Record<string, string>)[k]).toBeTruthy();
    }
    expect(ar.common.dndA11y.instructions).not.toMatch(/space bar/i);
  });
});
