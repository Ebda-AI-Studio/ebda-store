/** The deployed StoreSchedule: the alarm logic (store-schedule.ts) wired to the real job starter. */
import { setCfBindings, type CfBindings } from './bindings';
import { StoreScheduleBase, type AlarmEvent } from './store-schedule';
import { getJob } from '../lib/jobs/registry';
import { startJob } from '../lib/jobs/start';
import { dispatchEventsToAll } from '../lib/jobs/dispatch-all';
import { failedEvent } from '../lib/jobs/failure';
import logger from '../lib/logger';

export class StoreSchedule extends StoreScheduleBase<CfBindings> {
  constructor(ctx: ConstructorParameters<typeof StoreScheduleBase>[0], env: CfBindings) {
    super(ctx, env);
    setCfBindings(env);
  }

  protected async dispatch(job: string, event: AlarmEvent): Promise<unknown> {
    const def = getJob(job);
    if (!def) throw new Error(`unknown job ${job}`);
    return startJob(def, event);
  }

  /** Same observability as a failed run: the `inngest/function.failed` event feeds alerts-failure-watch. */
  protected override async onGaveUp(job: string, event: AlarmEvent, err: unknown): Promise<void> {
    const def = getJob(job);
    if (!def) return;
    const error = err instanceof Error ? err : new Error(String(err));
    await dispatchEventsToAll(failedEvent(def, event, event.id, error));
  }

  protected override log(level: 'warn' | 'error', obj: Record<string, unknown>, msg: string): void {
    logger[level](obj, msg);
  }
}
