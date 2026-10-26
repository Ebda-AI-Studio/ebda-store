/**
 * Wires the job layer into the Inngest client without touching a single call site or function:
 *  - `createFunction` also records the function in the job registry (the Cloudflare runners
 *    execute the SAME handler), and on the Inngest side wraps the handler so a function whose
 *    group already runs on Cloudflare is a no-op there (no double run from a late cron/event);
 *  - `send` goes through the dispatcher (lib/jobs/dispatch.ts);
 *  - `step.sendEvent` inside a function still on Inngest goes through the dispatcher too.
 */
import { dispatchEvents } from './dispatch';
import { setRawInngestSend } from './dispatch-all';
import { jobRunsOnCf } from './flag';
import { registerJob } from './registry';
import type { JobEvent, JobHandler, JobOptions } from './types';

/* eslint-disable @typescript-eslint/no-explicit-any */
export function attachJobs<C extends { createFunction: any; send: any }>(client: C): C {
  const createFunction = client.createFunction.bind(client);
  const send = client.send.bind(client);
  setRawInngestSend(events => send(events));

  client.send = (async (payload: JobEvent | JobEvent[]) =>
    dispatchEvents(payload, events => send(events))) as C['send'];

  client.createFunction = ((options: JobOptions, handler: JobHandler) => {
    registerJob(options, handler);
    const guarded = async (ctx: any) => {
      if (jobRunsOnCf(options.id)) return { skipped: 'runs-on-cloudflare' };
      const step = Object.create(ctx.step);
      step.sendEvent = (id: string, payload: JobEvent | JobEvent[]) =>
        ctx.step.run(id, async () => {
          await dispatchEvents(payload, events => send(events));
          return null;
        });
      return (handler as any)({ ...ctx, step });
    };
    return createFunction(options, guarded);
  }) as C['createFunction'];

  return client;
}
