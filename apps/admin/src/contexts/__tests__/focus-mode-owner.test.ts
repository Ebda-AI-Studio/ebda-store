/**
 * Issue 2253 — a stored focus-mode state is restored only for the admin who
 * set it. Clearing it on logout left the other exit (a session that expires,
 * then a different admin signs in on the same device) restoring the previous
 * admin's store.
 */
import { describe, expect, it } from 'vitest';
import { restorableFocusStoreId } from '../FocusModeContext';

const state = (o: Record<string, unknown>) => JSON.stringify(o);

describe('restorableFocusStoreId (issue 2253)', () => {
  it("restores the owner's own focused store", () => {
    expect(restorableFocusStoreId(state({ storeId: 's1', userId: 'u1' }), 'u1')).toBe('s1');
  });
  it("never restores another admin's store", () => {
    expect(restorableFocusStoreId(state({ storeId: 's1', userId: 'u1' }), 'u2')).toBeNull();
  });
  it('drops a legacy state with no owner — it cannot be validated', () => {
    expect(restorableFocusStoreId(state({ storeId: 's1' }), 'u1')).toBeNull();
  });
  it('drops corrupt storage and a missing user', () => {
    expect(restorableFocusStoreId('{not json', 'u1')).toBeNull();
    expect(restorableFocusStoreId(state({ storeId: 's1', userId: 'u1' }), null)).toBeNull();
    expect(restorableFocusStoreId(null, 'u1')).toBeNull();
  });
});
