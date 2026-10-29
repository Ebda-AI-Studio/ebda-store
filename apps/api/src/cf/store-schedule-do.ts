/** The deployed StoreSchedule: the alarm logic (store-schedule.ts) wired to the real job starter. */
import { setCfBindings, type CfBindings } from './bindings';
import { StoreScheduleBase, type AlarmEvent, type LogFields } from './store-schedule';
import { getJob } from '../lib/jobs/registry';
import { startJob } from '../lib/jobs/start';
import { reportJobFailure } from '../lib/jobs/failure';
import logger from '../lib/logger';
import { writesFrozen } from '../lib/jobs/freeze';
import { doStoreIds } from '../lib/jobs/do-guard';

export class StoreSchedule extends StoreScheduleBase<CfBindings> {
  constructor(ctx: ConstructorParameters<typeof StoreScheduleBase>[0], env: CfBindings) {
    super(ctx, env);
    setCfBindings(env);
  }

  protected override isFrozen(): boolean {
    return writesFrozen(this.env);
  }

  protected async dispatch(job: string, event: AlarmEvent): Promise<unknown> {
    // The store went back to Postgres (flag flipped back): its global cron owns the job again, so this alarm starts nothing.
    if (!doStoreIds().has(event.data.storeId)) return 'not-a-do-store';
    const def = getJob(job);
    if (!def) throw new Error(`unknown job ${job}`);
    return startJob(def, event);
  }

  /** Same observability as a failed run: the direct P1 alert plus Sentry (lib/jobs/failure.ts). */
  protected override async onGaveUp(job: string, event: AlarmEvent, err: unknown): Promise<void> {
    const def = getJob(job);
    if (!def) return;
    const error = err instanceof Error ? err : new Error(String(err));
    await reportJobFailure(def, event, event.id, error);
  }

  protected override log(level: 'warn' | 'error', f: LogFields, msg: string): void {
    logger[level](
      { job: f.job, storeId: f.storeId, due: f.due, attempts: f.attempts, err: f.err },
      msg
    );
  }
}
