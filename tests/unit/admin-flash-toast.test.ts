// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { queueFlashToast, takeFlashToast } from '../../apps/admin/src/lib/flash-toast';

describe('flash toast (QA-B1)', () => {
  beforeEach(() => window.sessionStorage.clear());

  it('hands a queued message to the next page exactly once', () => {
    queueFlashToast('اتحفظ المنتج');
    expect(takeFlashToast()).toBe('اتحفظ المنتج');
    expect(takeFlashToast()).toBeNull();
  });

  it('returns null when nothing was queued', () => {
    expect(takeFlashToast()).toBeNull();
  });
});
