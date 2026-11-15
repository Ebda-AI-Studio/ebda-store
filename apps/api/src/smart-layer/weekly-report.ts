/**
 * The weekly "what could the guides not answer" digest (Smart Layer plan 4 A18). The assistant's `not_covered` turns of the last 7 days, grouped by
 * folded question text across every store on its Durable Object, become ONE info digest to the OS brain (via `sendAlert`, which mirrors it): at most one
 * message a week (Monday UTC, once per ISO week through a KV guard). Masked prompts only. Nothing here reads a merchant's data beyond the journal.
 */
import { summariseUnanswered, type AuditRow } from '@ebda/shared/smart-layer';
import { cfBindings } from '../cf/bindings';
import { doStoreIdList } from '../lib/store-backend';
import { sendAlert } from '../services/alerts.service';
import { storeSmartLayer } from '../lib/repo-factory';

const WEEK = 7 * 86_400_000;
const MAX_STORES = 500;
const MAX_PARALLEL = 10;
// pq-allow(unused-export): imported by tests/unit/assistant-eval.test.ts
export const isoWeek = (t: number): string => {
  const d = new Date(
    Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth(), new Date(t).getUTCDate())
  );
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const y = d.getUTCFullYear();
  return `${y}-W${String(Math.ceil(((d.getTime() - Date.UTC(y, 0, 1)) / 86_400_000 + 1) / 7)).padStart(2, '0')}`;
};

interface WeeklyDeps {
  now?: number;
  stores?: () => Promise<string[]>;
  load?: (storeId: string, since: number) => Promise<AuditRow[]>;
  kv?: { get(k: string): Promise<string | null>; put(k: string, v: string): Promise<void> };
  send?: (text: string, top: Array<{ question: string; count: number }>) => Promise<unknown>;
}

export async function weeklyUnanswered(
  d: WeeklyDeps = {}
): Promise<'sent' | 'empty' | 'not_monday' | 'already_sent'> {
  const now = d.now ?? Date.now();
  if (new Date(now).getUTCDay() !== 1) return 'not_monday';
  const kv = d.kv ?? (cfBindings()?.KV_CACHE as WeeklyDeps['kv']);
  const key = `sl:weekly:${isoWeek(now)}`;
  if (kv && (await kv.get(key))) return 'already_sent';
  const load =
    d.load ??
    (async (s, since) =>
      (await (
        await storeSmartLayer(s)
      )('loadAudits', [s, since, 500])) as AuditRow[]);
  const rows: AuditRow[] = [];
  // Bounded fan-out: at most MAX_STORES stores per run, MAX_PARALLEL journal reads at a time (never one RPC after another for the whole fleet).
  const ids = (await (d.stores ?? doStoreIdList)()).slice(0, MAX_STORES);
  for (let i = 0; i < ids.length; i += MAX_PARALLEL)
    for (const part of await Promise.all(
      ids.slice(i, i + MAX_PARALLEL).map(s => load(s, now - WEEK).catch(() => [] as AuditRow[]))
    ))
      rows.push(...part);
  const top = summariseUnanswered(rows).slice(0, 15);
  if (!top.length) return 'empty';
  // Ruling SL-DIGEST-1: the questions are MASKED merchant text (phones, e-mails, cards removed; a shopper's name can survive); the digest goes only to the OS brain
  // (Ahmad's own channel), is cut to 80 characters per question and never names a store. Cost if wrong: a name inside a question reaches the brain log once a week.
  const text = top.map(t => `${t.count}x ${t.question.slice(0, 80)}`).join('\n');
  await (
    d.send ??
    ((tx: string) =>
      sendAlert({
        level: 'info',
        source: 'assistant.weekly-unanswered',
        title: 'Assistant: questions the guides could not answer this week',
        body: tx,
      }))
  )(text, top);
  await kv?.put(key, '1');
  return 'sent';
}
