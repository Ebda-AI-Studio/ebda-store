/**
 * Task 13: `render` posts coalesce to ONE per animation frame (latest wins), so a burst of
 * keystrokes costs one structured clone, not one per key.
 */
import { describe, expect, it, vi } from 'vitest';
import { createFrameCoalescer } from './frame-coalescer';

function fakeRaf() {
  let next = 1;
  const pending = new Map<number, () => void>();
  return {
    raf: (cb: () => void) => {
      const id = next++;
      pending.set(id, cb);
      return id;
    },
    caf: (id: number) => void pending.delete(id),
    frame: () => {
      const cbs = [...pending.values()];
      pending.clear();
      cbs.forEach(cb => cb());
    },
    size: () => pending.size,
  };
}

describe('createFrameCoalescer', () => {
  it('posts once per frame with the latest value', () => {
    const f = fakeRaf();
    const post = vi.fn();
    const c = createFrameCoalescer<string>(post, f);
    c.schedule('a');
    c.schedule('b');
    c.schedule('c');
    expect(post).not.toHaveBeenCalled();
    expect(f.size()).toBe(1);
    f.frame();
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith('c');
    c.schedule('d');
    f.frame();
    expect(post).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenLastCalledWith('d');
  });

  it('cancel drops the pending post; flush posts it now', () => {
    const f = fakeRaf();
    const post = vi.fn();
    const c = createFrameCoalescer<string>(post, f);
    c.schedule('a');
    c.cancel();
    f.frame();
    expect(post).not.toHaveBeenCalled();
    c.schedule('b');
    c.flush();
    expect(post).toHaveBeenCalledWith('b');
    f.frame();
    expect(post).toHaveBeenCalledTimes(1);
  });
});
