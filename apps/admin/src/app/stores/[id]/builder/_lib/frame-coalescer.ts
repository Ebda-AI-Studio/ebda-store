/**
 * Coalesce a burst of values into ONE call per animation frame (latest wins). The canvas `render`
 * post is a structured clone of the whole document; typing 10 keys inside one frame must cost one
 * clone, not ten.
 */
export interface FrameScheduler {
  raf: (cb: () => void) => number;
  caf: (id: number) => void;
}

export interface FrameCoalescer<T> {
  schedule: (value: T) => void;
  /** Post the pending value now (if any). */
  flush: () => void;
  /** Drop the pending value. */
  cancel: () => void;
}

const browser = (): FrameScheduler => ({
  raf: cb => window.requestAnimationFrame(cb),
  caf: id => window.cancelAnimationFrame(id),
});

export function createFrameCoalescer<T>(
  post: (value: T) => void,
  scheduler: FrameScheduler = browser()
): FrameCoalescer<T> {
  let id: number | null = null;
  let has = false;
  let latest: T;
  const run = () => {
    id = null;
    if (!has) return;
    has = false;
    post(latest);
  };
  return {
    schedule(value) {
      latest = value;
      has = true;
      if (id === null) id = scheduler.raf(run);
    },
    flush() {
      if (id !== null) scheduler.caf(id);
      run();
    },
    cancel() {
      if (id !== null) scheduler.caf(id);
      id = null;
      has = false;
    },
  };
}
