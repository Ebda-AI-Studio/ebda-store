/**
 * Dispatch used by running jobs (`step.sendEvent`, the failure event): the same routing as
 * `inngest.send`, falling back to the real Inngest client registered by `attachJobs`. Held in a
 * module variable (not imported) so the client module never forms an import cycle with the runners.
 */
import { dispatchEvents } from './dispatch';
import type { JobEvent } from './types';

let rawSend: ((events: JobEvent[]) => Promise<unknown>) | undefined;

export function setRawInngestSend(fn: (events: JobEvent[]) => Promise<unknown>): void {
  rawSend = fn;
}

export async function dispatchEventsToAll(payload: JobEvent | JobEvent[]): Promise<unknown> {
  return dispatchEvents(payload, async events => {
    if (!rawSend) throw new Error('Inngest client not initialised');
    return rawSend(events);
  });
}
