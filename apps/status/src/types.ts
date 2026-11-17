export interface Localized {
  en: string;
  ar: string;
}

export interface ComponentConfig {
  id: string;
  name: Localized;
  /** Which product the component belongs to (PRODUCTS in config.ts); `studio` = the company's own surfaces. */
  product: string;
  url: string;
  /** Exact HTTP status the probe must see. */
  expectStatus: number;
  /** Case-insensitive regex source the first 64 KiB of the body must match. */
  expectBody?: string;
  timeoutMs?: number;
}

export interface ProbeResult {
  id: string;
  ok: boolean;
  /** HTTP status, or null when no response arrived (timeout / network error). */
  status: number | null;
  latencyMs: number;
  /** True when the probe SUCCEEDED but took longer than SLOW_THRESHOLD_MS (degraded, not down). */
  slow?: boolean;
  /** Short machine-readable reason, null when ok. */
  error: string | null;
}

export interface Thresholds {
  /** Consecutive failures that open an incident. */
  fail: number;
  /** Consecutive successes that resolve it. */
  recover: number;
}

export type Impact = 'degraded' | 'outage';
export type IncidentStatus = 'investigating' | 'identified' | 'monitoring' | 'resolved';
export type ComponentStatus = 'operational' | 'degraded' | 'outage' | 'unknown';

export interface IncidentUpdate {
  at: number;
  status: IncidentStatus;
  body: string;
  bodyAr: string | null;
}

export interface Incident {
  id: number;
  component: string | null;
  title: string;
  titleAr: string | null;
  impact: Impact;
  status: IncidentStatus;
  source: 'auto' | 'manual';
  openedAt: number;
  resolvedAt: number | null;
  updates: IncidentUpdate[];
}

export interface DayBucket {
  /** UTC date, YYYY-MM-DD. */
  day: string;
  checks: number;
  ok: number;
}

export interface ComponentSnapshot {
  id: string;
  status: ComponentStatus;
  lastChecked: number | null;
  latencyMs: number | null;
  /** The latest successful probe was slow (8 s < t <= 15 s). */
  slow: boolean;
  lastError: string | null;
  /** Percentage over the shown history, or null with no data. */
  uptime: number | null;
  /** HISTORY_DAYS entries, oldest first; checks=0 means no data that day. */
  days: DayBucket[];
}

export interface Snapshot {
  generatedAt: number;
  overall: ComponentStatus;
  components: ComponentSnapshot[];
  active: Incident[];
  recent: Incident[];
}

export interface RecordOutcome {
  opened: number[];
  resolved: number[];
}
