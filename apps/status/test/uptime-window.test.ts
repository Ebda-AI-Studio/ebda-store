/** STATUS-WINDOW-1: the headline uptime is the LAST 30 DAYS of the same daily buckets; the 90-day figure stays; an Oct 27-31 resolved note shows while covered. */
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { COMPONENTS, HISTORY_DAYS } from '../src/config';
import { migrationNote, renderStatusPage } from '../src/render';
import { HEADLINE_DAYS, uptimeOver } from '../src/uptime';
import type { Snapshot } from '../src/types';

const DAY = 86_400_000;
const stub = () => env.STATUS_STORE.get(env.STATUS_STORE.idFromName('global'));
const day = (now: number, ago: number) => new Date(now - ago * DAY).toISOString().slice(0, 10);

describe('uptimeOver (the 30-day math)', () => {
  const d = (checks: number, ok: number) => ({ checks, ok });
  it('uses ONLY the last n buckets (oldest first, today last)', () => {
    const days = [
      ...Array.from({ length: 60 }, () => d(100, 0)),
      ...Array.from({ length: 30 }, () => d(100, 100)),
    ];
    expect(uptimeOver(days, 30)).toBe(100);
    expect(uptimeOver(days, 90)).toBe(33.33);
  });
  it('the boundary: bucket 30 back is included, bucket 31 back is not', () => {
    const days = [d(100, 0), ...Array.from({ length: 30 }, () => d(100, 100))]; // 31 buckets, the oldest is the bad one
    expect(uptimeOver(days, 30)).toBe(100);
    expect(uptimeOver(days, 31)).toBe(96.77);
  });
  it('rounds to 2 decimals and weights days by their checks', () => {
    expect(uptimeOver([d(1000, 999), d(10, 0)], 30)).toBe(98.91);
  });
  it('a window with no checks is null, never 100 %; empty days with data elsewhere in the window are ignored', () => {
    expect(uptimeOver([], 30)).toBeNull();
    expect(
      uptimeOver(
        Array.from({ length: 90 }, () => d(0, 0)),
        30
      )
    ).toBeNull();
    const days = [...Array.from({ length: 89 }, () => d(0, 0)), d(10, 10)];
    expect(uptimeOver(days, 30)).toBe(100);
  });
  it('fewer buckets than n uses them all', () => {
    expect(uptimeOver([d(10, 5)], 30)).toBe(50);
  });
  it('the headline window is 30 days and the history 90', () => {
    expect(HEADLINE_DAYS).toBe(30);
    expect(HISTORY_DAYS).toBe(90);
  });
});

describe('snapshot + JSON + page', () => {
  beforeEach(async () => {
    await runInDurableObject(stub(), (_i, state) => {
      for (const t of ['component_state', 'daily', 'incidents', 'incident_updates'])
        state.storage.sql.exec(`DELETE FROM ${t}`);
    });
  });

  async function seed(component: string) {
    const now = Date.now();
    await runInDurableObject(stub(), (_i, state) => {
      // days 0..29 ago: 100 %; days 30..89 ago: 50 %
      for (let ago = 0; ago < HISTORY_DAYS; ago++)
        state.storage.sql.exec(
          `INSERT INTO daily (day, component, checks, ok) VALUES (?, ?, 100, ?)`,
          day(now, ago),
          component,
          ago < 30 ? 100 : 50
        );
    });
  }

  it('/api/status.json carries uptime30d NEXT TO the unchanged 90-day uptime', async () => {
    const id = COMPONENTS[0]!.id;
    await seed(id);
    const snap = (await (
      await worker.fetch(new Request('https://status.ebda.app/api/status.json'), env)
    ).json()) as Snapshot;
    const c = snap.components.find(x => x.id === id)!;
    expect(c.uptime30d).toBe(100);
    // 30 days at 100 % + 60 days at 50 % = 6000 / 9000 checks... (30*100 + 60*50) / 9000
    expect(c.uptime).toBe(66.67);
    expect(Object.keys(c)).toContain('uptime'); // not renamed
    const other = snap.components.find(x => x.id !== id)!;
    expect(other.uptime30d).toBeNull();
    expect(other.uptime).toBeNull();
  });

  it('the page headlines the 30-day figure and keeps the 90-day figure visible, in both languages', async () => {
    const id = COMPONENTS[0]!.id;
    await seed(id);
    const snap = (await (
      await worker.fetch(new Request('https://status.ebda.app/api/status.json'), env)
    ).json()) as Snapshot;
    const en = renderStatusPage(snap, 'en', 'https://status.ebda.app');
    expect(en.includes('<strong class="up30">30-day uptime: 100.00%</strong>')).toBe(true);
    expect(en.includes('<span class="up90">90-day: 66.67%</span>')).toBe(true);
    const ar = renderStatusPage(snap, 'ar', 'https://status.ebda.app');
    expect(ar.includes('نسبة التشغيل في آخر 30 يوم: 100.00%')).toBe(true);
    expect(ar.includes('آخر 90 يوم: 66.67%')).toBe(true);
  });
});

describe('the Oct 27-31 resolved note', () => {
  const snapWith = (days: string[]): Snapshot =>
    ({
      components: [{ days: days.map(d => ({ day: d, checks: 1, ok: 1 })) }],
      active: [],
      recent: [],
      overall: 'operational',
      generatedAt: 0,
    }) as unknown as Snapshot;
  const t = { migrationNote: 'note <b>' };

  it('shows while ANY of Oct 27-31 2026 is inside the shown history', () => {
    expect(migrationNote(snapWith(['2026-10-26', '2026-10-27']), t)).toContain(
      'id="migration-note"'
    );
    expect(migrationNote(snapWith(['2026-10-31', '2026-11-01']), t)).toContain(
      'id="migration-note"'
    );
  });
  it('is hidden once the history starts after Oct 31 (and before Oct 27), and escapes its text', () => {
    expect(migrationNote(snapWith(['2026-11-01', '2026-11-02']), t)).toBe('');
    expect(migrationNote(snapWith(['2026-10-01', '2026-10-26']), t)).toBe('');
    expect(migrationNote(snapWith([]), t)).toBe('');
    expect(migrationNote(snapWith(['2026-10-28']), t)).toContain('note &lt;b&gt;');
  });
  it('is worded in Egyptian Arabic and English, naming admin, orders and the API', () => {
    const en = renderStatusPage(snapWith(['2026-10-28']), 'en', 'https://status.ebda.app');
    expect(en).toContain(
      'Oct 27-31: admin, orders and the API were partly unavailable during a platform migration; resolved.'
    );
    const ar = renderStatusPage(snapWith(['2026-10-28']), 'ar', 'https://status.ebda.app');
    expect(ar).toContain(
      'من 27 لـ 31 أكتوبر: لوحة التحكم والطلبات والـ API كانت شغّالة جزئيًا بس وإحنا بننقل المنصة. المشكلة اتحلّت.'
    );
  });
});
