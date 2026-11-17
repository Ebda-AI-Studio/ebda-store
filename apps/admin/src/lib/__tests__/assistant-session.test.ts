// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { clearStoredSession } from '../api';
import { conversationIdFor } from '../assistant';

// Review of the assistant (Opus): the conversation id belongs to the person, never to the shared browser tab.
describe('assistant conversation id', () => {
  it('is kept per store and user, and signing out clears every one', () => {
    const mem = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => mem.set(k, v),
      removeItem: (k: string) => mem.delete(k),
    });
    const owner = conversationIdFor('s1', 'owner');
    const staff = conversationIdFor('s1', 'staff');
    expect(owner).not.toBe(staff);
    expect(conversationIdFor('s1', 'owner')).toBe(owner);
    clearStoredSession();
    expect(
      Object.keys(sessionStorage).filter(k => k.startsWith('assistant.conversation.'))
    ).toEqual([]);
    expect(conversationIdFor('s1', 'staff')).not.toBe(staff);
  });
});
