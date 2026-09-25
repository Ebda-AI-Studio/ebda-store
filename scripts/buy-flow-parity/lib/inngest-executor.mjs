/**
 * Minimal, deterministic Inngest executor.
 *
 * Production runs every post-purchase side effect (order/created notifications,
 * order/refunded stock + coupon reversal, payment/webhook.received processing)
 * as an Inngest function. A parity run that only RECORDED those events would
 * never execute the code that returns stock on a cancel — so this executor
 * drives the API's own `/api/v1/inngest` serve endpoint the way the Inngest
 * executor does (the SDK's HTTP step protocol), synchronously and in a fixed
 * order, identically for both refs:
 *
 * - functions come from the SDK's own registration (`PUT /api/v1/inngest` →
 *   stub `/fn/register`), matched by event trigger; crons are never run;
 * - each event is processed FIFO right after the request that emitted it;
 *   events a function emits are queued and processed the same way;
 * - a step that errors is memoised as its final error (no retries — both refs
 *   get the same single attempt) and the run outcome is recorded;
 * - sleep / waitForEvent / invoke resolve immediately with null.
 *
 * Deviations from the real Inngest (no retries, no concurrency/throttle/
 * debounce/idempotency windows, no `inngest/function.failed` fan-out) apply to
 * BOTH refs, so they cannot create or hide a difference between them.
 */

import { LOAD_TEST_HEADER } from './client.mjs';

const MAX_CALLS_PER_RUN = 200;
const MAX_EVENTS_PER_DRAIN = 200;

export function createExecutor({ stub, apiOrigin }) {
  let runSeq = 0;
  const runs = [];

  async function register() {
    const r = await fetch(`${apiOrigin}/api/v1/inngest`, {
      method: 'PUT',
      headers: LOAD_TEST_HEADER,
    });
    const text = await r.text();
    if (!stub.state.functions.length) {
      throw new Error(
        `Inngest registration captured no functions (PUT → ${r.status} ${text.slice(0, 300)})`
      );
    }
    return stub.state.functions.length;
  }

  function functionsFor(eventName) {
    return stub.state.functions
      .filter(f => (f.triggers ?? []).some(t => t.event === eventName))
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  }

  function stepUrl(fn) {
    const s = fn.steps?.step ?? Object.values(fn.steps ?? {})[0];
    const u = new URL(s.runtime.url);
    // Always call the API under test on loopback, whatever host it advertised.
    const api = new URL(apiOrigin);
    u.protocol = api.protocol;
    u.host = api.host;
    return u;
  }

  async function runFunction(fn, event) {
    const runId = `run-${++runSeq}`;
    const steps = {};
    const stack = [];
    const trace = [];
    const pending = [];
    let outcome = null;
    for (let calls = 0; calls < MAX_CALLS_PER_RUN && !outcome; calls++) {
      const url = stepUrl(fn);
      url.searchParams.set('fnId', fn.id);
      url.searchParams.set('stepId', pending.length ? pending.shift() : 'step');
      const body = {
        version: 2,
        event,
        events: [event],
        steps,
        ctx: {
          run_id: runId,
          fn_id: fn.id,
          attempt: 0,
          max_attempts: 1,
          disable_immediate_execution: false,
          use_api: false,
          stack: { stack: [...stack], current: stack.length - 1 },
        },
      };
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-inngest-server-kind': 'dev',
          // The API's global IP rate limiter is mounted in front of
          // /api/v1/inngest too; a full run makes several hundred step calls
          // from one IP. Same bypass the shopper clients use (client.mjs).
          ...LOAD_TEST_HEADER,
        },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      let parsed = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = text;
      }
      if (res.status === 200) {
        outcome = { status: 'completed' };
        break;
      }
      if (res.status !== 206) {
        outcome = { status: 'failed', http: res.status, error: summariseError(parsed) };
        break;
      }
      const ops = Array.isArray(parsed) ? parsed : [parsed];
      for (const op of ops) {
        const name = op.displayName ?? op.name ?? op.id;
        switch (op.op) {
          case 'StepRun':
            steps[op.id] = { type: 'data', data: op.data ?? null };
            stack.push(op.id);
            trace.push({ step: name, op: 'ran' });
            break;
          case 'StepError':
          case 'StepFailed':
            steps[op.id] = {
              type: 'error',
              error: op.error ?? { name: 'Error', message: 'unknown' },
            };
            stack.push(op.id);
            trace.push({ step: name, op: 'error', error: summariseError(op.error) });
            break;
          case 'StepPlanned':
            if (!pending.includes(op.id)) pending.push(op.id);
            break;
          case 'Sleep':
          case 'WaitForEvent':
          case 'WaitForSignal':
          case 'InvokeFunction':
            steps[op.id] = { type: 'data', data: null };
            stack.push(op.id);
            trace.push({ step: name, op: op.op });
            break;
          case 'RunComplete':
            outcome = { status: 'completed' };
            break;
          default:
            trace.push({ step: name, op: `unhandled:${op.op}` });
            outcome = { status: 'failed', error: `executor cannot handle op ${op.op}` };
        }
      }
    }
    if (!outcome) outcome = { status: 'failed', error: `exceeded ${MAX_CALLS_PER_RUN} calls` };
    const run = { event: event.name, function: fn.id, ...outcome, steps: trace };
    runs.push(run);
    return run;
  }

  /** Process every queued event (and every event those runs emit), FIFO. */
  async function drain() {
    let n = 0;
    while (stub.state.eventQueue.length) {
      if (++n > MAX_EVENTS_PER_DRAIN) throw new Error('Inngest drain did not converge');
      const ev = stub.state.eventQueue.shift();
      const event = {
        name: ev.name,
        data: ev.data ?? {},
        id: ev.id,
        ts: ev.ts ?? Date.now(),
        user: ev.user ?? {},
      };
      for (const fn of functionsFor(ev.name)) await runFunction(fn, event);
    }
  }

  return {
    register,
    drain,
    takeRuns() {
      const r = runs.splice(0, runs.length);
      return r;
    },
  };
}

function summariseError(e) {
  if (e == null) return null;
  if (typeof e === 'string') return e.slice(0, 500);
  const raw = e.message ?? e.error ?? e;
  const msg = typeof raw === 'string' ? raw : JSON.stringify(raw);
  return `${e.name ?? 'Error'}: ${msg.slice(0, 500)}`;
}
