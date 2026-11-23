import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import en from '../i18n/messages/en.json';
import ar from '../i18n/messages/ar.json';
import {
  STATUS_FAMILIES,
  TONE_CLASSES,
  getStatusEntry,
  isKnownStatus,
  type StatusFamily,
} from './status-tones';

type Json = { [k: string]: Json | string };
const at = (root: Json, path: string): Json | undefined =>
  path
    .split('.')
    .reduce<
      Json | undefined
    >((x, k) => (x && typeof x === 'object' ? (x[k] as Json) : undefined), root);

const families = Object.keys(STATUS_FAMILIES) as StatusFamily[];

describe('status tone registry', () => {
  it.each(families)('%s: no two statuses share a tone', family => {
    const tones = Object.values(STATUS_FAMILIES[family].statuses).map(s => s.tone);
    expect(new Set(tones).size).toBe(tones.length);
  });

  it.each(families)('%s: every status has a tone class and an icon', family => {
    for (const [status, entry] of Object.entries(STATUS_FAMILIES[family].statuses)) {
      expect(TONE_CLASSES[entry.tone], `${family}.${status}`).toBeTruthy();
      expect(entry.icon, `${family}.${status}`).toBeTruthy();
    }
  });

  it.each(families)('%s: every status has an en + ar label', family => {
    const ns = STATUS_FAMILIES[family].labelNamespace;
    if (!ns) return;
    for (const [locale, messages] of [
      ['en', en],
      ['ar', ar],
    ] as const) {
      const bag = at(messages as unknown as Json, ns);
      for (const status of Object.keys(STATUS_FAMILIES[family].statuses)) {
        expect(typeof bag?.[status], `${locale} ${ns}.${status}`).toBe('string');
      }
    }
  });

  it('the audit clash is gone: shipped and InstaPay-unconfirmed have different tones', () => {
    const shipped = getStatusEntry('order', 'shipped').tone;
    const unconfirmed = getStatusEntry('order', 'awaiting_payment_confirmation').tone;
    expect(shipped).not.toBe(unconfirmed);
    expect(getStatusEntry('payment', 'awaiting_payment_confirmation').tone).toBe(unconfirmed);
    expect(getStatusEntry('shipment', 'in_transit').tone).toBe(shipped);
  });

  it('shared words keep one meaning across families', () => {
    for (const f of families) {
      if (isKnownStatus(f, 'delivered'))
        expect(getStatusEntry(f, 'delivered').tone).toBe('success');
      if (isKnownStatus(f, 'failed')) expect(getStatusEntry(f, 'failed').tone).toBe('danger');
    }
  });

  it('an unknown status degrades to neutral instead of throwing', () => {
    expect(getStatusEntry('order', 'brand_new_state').tone).toBe('neutral');
  });

  it('uses no orange in the tone palette (Ebda palette)', () => {
    expect(Object.values(TONE_CLASSES).join(' ')).not.toMatch(/orange|amber/);
  });
});

// Guard: a component must not define its own status colour map. All status colour lives in status-tones.ts.
const SRC = join(__dirname, '..');
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap(n => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === 'node_modules' ? [] : walk(p);
    return /\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n) ? [p] : [];
  });

// Non-status palettes (loyalty tiers, customer segments) are categories, not statuses.
const ALLOWED = [
  'lib/status-tones.ts',
  'insights/segments/page.tsx',
  'loyalty/_components/types.ts',
  'app/ai-usage/page.tsx',
];

describe('no local status colour maps', () => {
  it('no file declares its own STATUS/colorMap colour table', () => {
    const offenders: string[] = [];
    const decl =
      /(?:const|let)\s+\w*(?:STATUS|Status|status)\w*(?:COLORS|COLOURS|CLASS|CLASSES|STYLES|TONES)\w*\s*(?::[^=]+)?=|(?:const|let)\s+\w*(?:COLORS|COLOURS)\s*(?::[^=]+)?=\s*\{|colorMap\s*[=:{]/;
    for (const file of walk(SRC)) {
      const rel = relative(SRC, file).split('\\').join('/');
      if (ALLOWED.some(a => rel.endsWith(a))) continue;
      if (decl.test(readFileSync(file, 'utf8'))) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it('InstaPay-unconfirmed panel does not reuse the shipped (violet) tone', () => {
    const f = join(SRC, 'app/stores/[id]/orders/[orderId]/_components/PaymentCard.tsx');
    expect(readFileSync(f, 'utf8')).not.toMatch(/violet-/);
  });
});
