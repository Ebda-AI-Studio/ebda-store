/**
 * Injectable randomness and clock for the write engine. Normal use: real `crypto.randomUUID()` / `new Date()`.
 * The D1 client replays a write from its start after every statement it has really executed, so the ids and the
 * timestamp a write generates must be the SAME on every replay (otherwise a later statement would address a row id
 * the earlier INSERT never used). `withEntropy` pins them for one synchronous section.
 */
export interface Entropy {
  uuid(): string;
  now(): Date;
}
let current: Entropy | null = null;

export const newUuid = (): string => (current ? current.uuid() : crypto.randomUUID());
export const newNow = (): Date => (current ? current.now() : new Date());

/** Run a SYNCHRONOUS function with pinned entropy (restored even on throw). */
export function withEntropy<T>(e: Entropy, fn: () => T): T {
  const prev = current;
  current = e;
  try {
    return fn();
  } finally {
    current = prev;
  }
}
