// The vitest test worker's own entry: it serves nothing. Tests reach the built API Worker through
// the `API` service binding (vitest.workers.config.mts).
//
// It also hosts TestSchedule: the real alarm logic of StoreSchedule (src/cf/store-schedule.ts) with a
// recording dispatcher. `runDurableObjectAlarm` only works on Durable Objects defined in the SAME
// worker as the test, so the alarm semantics are tested here and the wiring to the real job starter
// (cf/store-schedule-do.ts) is a thin class covered by the built-Worker test.
import { StoreScheduleBase, type AlarmEvent } from '../src/cf/store-schedule';

export class TestSchedule extends StoreScheduleBase {
  protected async dispatch(job: string, event: AlarmEvent): Promise<void> {
    const kv = this.ctx.storage.kv;
    const failures = Number(kv.get('failures') ?? 0);
    if (failures > 0) {
      kv.put('failures', failures - 1);
      throw new Error('workflows down');
    }
    const calls = (kv.get('calls') as { job: string; event: AlarmEvent }[] | undefined) ?? [];
    calls.push({ job, event });
    kv.put('calls', calls);
  }

  protected override async onGaveUp(job: string): Promise<void> {
    const kv = this.ctx.storage.kv;
    kv.put('gaveUp', [...((kv.get('gaveUp') as string[] | undefined) ?? []), job]);
  }

  /** Write freeze (Ruling CF-JOBS-2): the deployed class reads WRITES_FROZEN; the test flips it per instance. */
  protected override isFrozen(): boolean {
    return this.ctx.storage.kv.get('frozen') === true;
  }
  setFrozen(on: boolean): void {
    this.ctx.storage.kv.put('frozen', on);
  }

  failNext(n: number): void {
    this.ctx.storage.kv.put('failures', n);
  }
  calls(): { job: string; event: AlarmEvent }[] {
    return (this.ctx.storage.kv.get('calls') as { job: string; event: AlarmEvent }[]) ?? [];
  }
  gaveUp(): string[] {
    return (this.ctx.storage.kv.get('gaveUp') as string[]) ?? [];
  }
}

export default {
  fetch(): Response {
    return new Response('test worker');
  },
};
