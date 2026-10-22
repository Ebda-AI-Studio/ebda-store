/**
 * Inngest cron execution budget (Ruling INNGEST-BUDGET-1, docs/RULINGS.md).
 *
 * Ebda is on the Inngest Hobby plan: 50,000 executions a month. An execution is one function RUN plus
 * one per `step.run` (Executions = runs x (steps + 1), https://www.inngest.com/pricing). Pre-launch
 * there is no order traffic, so the usage is almost all cron ticks: on 2026-10-22 it was 27,313 used
 * (~38k projected), with nine functions firing every 15 minutes.
 *
 * BUDGET_CRON_EXECUTIONS = 12,000 a month for ALL cron-triggered functions. That leaves ~38,000 of the
 * 50,000 for event-driven work, bursts and a retry storm. Today the crons price at 11,036: 10,198 runs,
 * and the undeclared single-step daily/weekly crons priced at runs x 2 (the table prints on failure).
 * The number is deliberately tight. A new every-15-minute cron is 2,880 runs (5,760 if it opens a step),
 * every-5-minutes is 8,640, and even a new hourly one is 1,440: none fit without this file being edited
 * in the same PR, and raising the number means writing the new total into the ruling.
 *
 * A tick that finds nothing must cost ONE execution. A function whose empty path opens a step is priced
 * at runs x 2 unless EMPTY_PATH_STEPS declares otherwise; declaring 0 is a claim that the handler reads
 * un-stepped first and returns when empty (`stepRunUnlessEmpty`, or no step at all).
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { collectCronFunctions, firesPerMonth } from '../helpers/inngest-cron-budget';

export const BUDGET_CRON_EXECUTIONS = 12_000;

/** Steps opened on a tick that finds NOTHING TO DO. Undeclared cron = 1 (conservative). */
export const EMPTY_PATH_STEPS: Record<string, number> = {
  'agent-write-denied-watch': 0, // no step at all
  'domain-claim-sweep': 0, // no step at all (one idempotent unit)
  'gmail-alert-poller': 0, // no step at all
  'gold-rate-feed-fetch': 0, // un-stepped definer read of the opted-in stores; none = return (Task B5-11)
  'gold-rate-staleness-watch': 0, // un-stepped definer read of rates inside the warning window; none = return
  heartbeat: 0, // no step at all
  'instapay-expiry': 0, // stepRunUnlessEmpty
  'order-created-stuck-sweep': 0, // stepRunUnlessEmpty
  'order-status-fanout-stuck-sweep': 0, // stepRunUnlessEmpty x2
  'payment-abandonment-sweep': 0, // stepRunUnlessEmpty
  'payment-reconcile-sweep': 0, // stepRunUnlessEmpty
  'payment-webhook-stuck-sweep': 0, // stepRunUnlessEmpty
  'queue-depth-watch': 0, // no step at all
  'refund-reversal-stuck-sweep': 0, // stepRunUnlessEmpty x3
};

const FUNCTIONS_DIR = path.resolve(__dirname, '../../apps/api/src/lib/inngest/functions');
const crons = collectCronFunctions(FUNCTIONS_DIR);
const executions = (c: (typeof crons)[number]) =>
  c.firesPerMonth * (1 + (EMPTY_PATH_STEPS[c.id] ?? 1));
const total = crons.reduce((n, c) => n + executions(c), 0);
const table = () =>
  crons
    .map(c => ({ ...c, ex: executions(c) }))
    .sort((a, b) => b.ex - a.ex)
    .map(c => `${String(c.ex).padStart(6)}  ${c.cron.padEnd(22)} ${c.id}`)
    .join('\n');

describe('cron schedule maths', () => {
  it.each([
    ['*/5 * * * *', 8_640],
    ['*/15 * * * *', 2_880],
    ['*/30 * * * *', 1_440],
    ['7 * * * *', 720],
    ['17 */6 * * *', 120],
    ['0 */4 * * *', 180],
    ['0 6 * * *', 30],
    ['TZ=<tz> 30 1 * * *', 30],
    ['0 3 * * 0', 5],
    ['0 2 1 * *', 1],
  ])('%s fires %i times in a 30-day month', (expr, n) => {
    expect(firesPerMonth(expr)).toBe(n);
  });
});

describe('Inngest cron execution budget (INNGEST-BUDGET-1)', () => {
  it('finds the registry (a parser that sees nothing would pass any budget)', () => {
    expect(crons.length).toBeGreaterThan(30);
    expect(crons.map(c => c.id)).toContain('heartbeat');
  });

  it('every cron function file is imported by the registry', () => {
    expect(crons.filter(c => !c.registered).map(c => c.file)).toEqual([]);
  });

  it('every EMPTY_PATH_STEPS entry names a real cron function', () => {
    const ids = new Set(crons.map(c => c.id));
    expect(Object.keys(EMPTY_PATH_STEPS).filter(id => !ids.has(id))).toEqual([]);
  });

  it(`crons stay within ${BUDGET_CRON_EXECUTIONS} executions per 30-day month`, () => {
    expect(
      total,
      `cron executions/month = ${total} > ${BUDGET_CRON_EXECUTIONS}. Cheapest first:\n${table()}\n` +
        `Slow the new cron down, or make it exit before any step.run when idle and declare it in ` +
        `EMPTY_PATH_STEPS; raising BUDGET_CRON_EXECUTIONS needs a new total in Ruling INNGEST-BUDGET-1.`
    ).toBeLessThanOrEqual(BUDGET_CRON_EXECUTIONS);
  });

  it('nothing polls faster than every 30 minutes without an explicit budget decision', () => {
    // Every-5 and every-15 minutes are the cadences that caused the overrun (2026-10-22). The aggregate budget already
    // fails on a new one; this names the reason in the failure.
    const fast = crons.filter(c => c.firesPerMonth > 1_440);
    expect(
      fast.map(c => `${c.id} ${c.cron}`),
      'a cron firing more than every 30 minutes: update BUDGET_CRON_EXECUTIONS and Ruling INNGEST-BUDGET-1'
    ).toEqual([]);
  });
});
