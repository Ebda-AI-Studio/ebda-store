/** Client side of the JobGate Durable Object (cf/job-gate.ts) plus the concurrency/debounce specs. */
import { cfBindings } from '../../cf/bindings';
import type { ConcurrencySpec, JobDef, JobEvent } from './types';
import { readEventKey } from './path';
import { alarmStoreId } from './store-scope';
import { parseDurationMs } from './step-adapter';

interface GateStub {
  acquire(limit: number, ttlMs: number): Promise<string | null>;
  renew(token: string, ttlMs: number): Promise<boolean>;
  release(token: string): Promise<void>;
  touch(timeoutMs: number): Promise<string>;
  isLatest(token: string, timeoutMs: number): Promise<boolean>;
}

function stub(gateId: string): GateStub {
  const ns = cfBindings()?.JOB_GATE;
  if (!ns) throw new Error('JOB_GATE binding missing');
  return ns.get(ns.idFromName(gateId)) as unknown as GateStub;
}

/**
 * Limits above this were Inngest plan caps (INNGEST-PLAN-1: Hobby allows 5), not correctness
 * rules; Workflows and Queues scale on their own, so they are not enforced. 1-3 are real
 * "one sweep at a time" rules and stay enforced.
 */
export const MAX_ENFORCED_CONCURRENCY = 3;

/**
 * Lease length. A lease is renewed before EVERY step body (a step is capped at 15 minutes), and
 * released while the run sleeps (Inngest's concurrency also counts running steps, not sleeping
 * runs). So a live run always holds an unexpired lease, and a dead one frees the gate within 20 min.
 */
export const GATE_LEASE_TTL_MS = 20 * 60_000;

export interface Gate {
  gateId: string;
  limit: number;
}

/**
 * The gates a run must hold, in a fixed order (no deadlock between two multi-gate functions). An
 * alarm run (one store) with a global limit gets a per-store gate: the global one existed only
 * because the cron swept every store in a single run.
 */
export function gatesFor(def: JobDef, event: JobEvent): Gate[] {
  const c = def.options.concurrency;
  const specs: ConcurrencySpec[] = !c ? [] : Array.isArray(c) ? c : [c];
  return specs
    .filter(s => s.limit <= MAX_ENFORCED_CONCURRENCY)
    .map(s => ({
      gateId: `${def.id}|${readEventKey(event, s.key) ?? alarmStoreId(event) ?? '*'}`,
      limit: s.limit,
    }))
    .sort((a, b) => a.gateId.localeCompare(b.gateId));
}

export const gateClient = {
  acquire: (g: Gate, ttlMs: number) => stub(g.gateId).acquire(g.limit, ttlMs),
  renew: (g: Gate, token: string, ttlMs: number) => stub(g.gateId).renew(token, ttlMs),
  release: (g: Gate, token: string) => stub(g.gateId).release(token),
};

export interface DebounceSpec {
  gateId: string;
  periodMs: number;
  timeoutMs: number;
}

export function debounceFor(def: JobDef, event: JobEvent): DebounceSpec | null {
  const d = def.options.debounce;
  if (!d) return null;
  return {
    gateId: `${def.id}|debounce|${readEventKey(event, d.key) ?? '*'}`,
    periodMs: parseDurationMs(d.period),
    timeoutMs: d.timeout ? parseDurationMs(d.timeout) : 10 * 60_000,
  };
}

export const debounceClient = {
  touch: (d: DebounceSpec) => stub(d.gateId).touch(d.timeoutMs),
  isLatest: (d: DebounceSpec, token: string) => stub(d.gateId).isLatest(token, d.timeoutMs),
};
