import type { JobDef, JobHandler, JobOptions } from './types';

const defs = new Map<string, JobDef>();

/** Record a function the moment `inngest.createFunction` is called (lib/inngest/client.ts). */
export function registerJob(options: JobOptions, handler: JobHandler): JobDef {
  if (!options?.id) throw new Error('job without an id');
  const def: JobDef = { id: options.id, options, handler };
  defs.set(def.id, def);
  return def;
}

export function getJob(id: string): JobDef | undefined {
  return defs.get(id);
}

export function allJobs(): JobDef[] {
  return [...defs.values()];
}

/** Functions whose triggers include this event name. */
export function jobsForEvent(name: string): JobDef[] {
  return allJobs().filter(d => d.options.triggers?.some(t => t.event === name));
}

/** Test seam. */
export function clearJobRegistry(): void {
  defs.clear();
}
