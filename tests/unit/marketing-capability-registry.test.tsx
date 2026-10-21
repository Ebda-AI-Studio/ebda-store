/**
 * Truth-at-merge. These features merge in separate PRs; the marketing site must never claim one that is
 * not live. The registry (apps/marketing/src/lib/capability-registry.ts) says live | coming for each, every
 * page and llms file renders "coming soon" for the coming ones, and THIS FILE lists what flips when.
 *
 * FLIP_ON_MERGE: when a branch below merges, set those ids to `live` in the registry (and
 * `npm run llms-full -w @ebda/marketing`), then move the ids here to LIVE_ALREADY. The test fails
 * until the registry and this list agree, so a merge can neither be forgotten nor claimed early.
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { FeaturesPage } from '../../apps/marketing/src/components/FeaturesPage';
import { Home } from '../../apps/marketing/src/components/Home';
import { ComparePage } from '../../apps/marketing/src/components/ComparePage';
import {
  CAPABILITIES,
  CAPABILITY_IDS,
  featuresFaq,
} from '../../apps/marketing/src/lib/capabilities';
import { REGISTRY, type CapabilityId } from '../../apps/marketing/src/lib/capability-registry';
import { compareRows } from '../../apps/marketing/src/lib/compare';
import { COMPARE_SLUGS } from '../../apps/marketing/src/lib/site';

/** branch / PR -> the capability ids that go live when it merges */
const FLIP_ON_MERGE: Record<string, CapabilityId[]> = {
  'feat/search-p1c-hybrid (search PR4)': ['meaning'],
  'feat/merchant-webhooks': ['webhooks'],
  'feat/b2b-wholesale': ['b2b'],
};

const pub = (f: string) =>
  readFileSync(path.resolve(__dirname, '../../apps/marketing/public', f), 'utf8');
const coming = CAPABILITY_IDS.filter(id => REGISTRY[id].status === 'coming');
const live = CAPABILITY_IDS.filter(id => REGISTRY[id].status === 'live');

describe('capability registry', () => {
  it('covers every capability id exactly once', () => {
    expect(Object.keys(REGISTRY).sort()).toEqual([...CAPABILITY_IDS].sort());
  });
  it('the coming items and the flip-on-merge list agree, per branch', () => {
    const fromRegistry: Record<string, string[]> = {};
    for (const id of coming) {
      const dep = REGISTRY[id].dependsOn;
      expect(dep, `${id} is coming, so it needs dependsOn`).toBeTruthy();
      (fromRegistry[dep!] ??= []).push(id);
    }
    expect(Object.fromEntries(Object.entries(fromRegistry).map(([k, v]) => [k, v.sort()]))).toEqual(
      Object.fromEntries(Object.entries(FLIP_ON_MERGE).map(([k, v]) => [k, [...v].sort()]))
    );
  });
});

describe('a coming item says so everywhere; a live item never does', () => {
  const pages = {
    'features ar': renderToStaticMarkup(<FeaturesPage locale="ar" />),
    'features en': renderToStaticMarkup(<FeaturesPage locale="en" />),
    'home ar': renderToStaticMarkup(<Home locale="ar" />),
    'home en': renderToStaticMarkup(<Home locale="en" />),
  };
  for (const [name, html] of Object.entries(pages)) {
    it(`${name}: every coming capability card carries the badge`, () => {
      const isAr = name.endsWith('ar');
      for (const id of coming) {
        const card = html.match(
          new RegExp(`<li class="cap-card" data-capability="${id}"[^>]*>.*?</li>`, 's')
        );
        if (!card) continue; // not every capability is on the home grid
        expect(card[0]).toContain('data-status="coming"');
        expect(card[0]).toContain(isAr ? 'قريبًا' : 'Coming soon');
      }
      for (const id of live) {
        const card = html.match(
          new RegExp(`<li class="cap-card" data-capability="${id}"[^>]*>.*?</li>`, 's')
        );
        if (card) expect(card[0]).toContain('data-status="live"');
      }
    });
  }
  it('every coming capability is on /features', () => {
    for (const id of coming) expect(pages['features en']).toContain(`data-capability="${id}"`);
  });
  it('FAQ answers follow the registry', () => {
    const faq = featuresFaq('en')
      .map(f => f.a)
      .join(' ');
    for (const id of coming) expect(faq).toMatch(/coming soon|rolling out|Until it ships/i);
    expect(faq).not.toMatch(/undefined/);
  });
  it('compare: a coming item sits in the not-yet table with the badge, never as a strength', () => {
    const { strength, gap } = compareRows();
    const comingNeeds = new Set(coming);
    for (const id of ['meaning', 'integrations', 'b2b', 'email']) {
      const needs = {
        meaning: 'meaning',
        integrations: 'webhooks',
        b2b: 'b2b',
        email: 'campaigns',
      }[id] as CapabilityId;
      const inGap = gap.some(r => r.id === id);
      const inStrength = strength.some(r => r.id === id);
      expect(inGap).toBe(comingNeeds.has(needs));
      expect(inStrength).toBe(!comingNeeds.has(needs));
    }
    for (const slug of COMPARE_SLUGS)
      for (const l of ['ar', 'en'] as const) {
        const html = renderToStaticMarkup(<ComparePage locale={l} slug={slug} />);
        expect(html.split('cap-badge').length - 1).toBeGreaterThanOrEqual(
          gap.filter(r => r.soon).length
        );
      }
  });
  it('llms.txt and llms-full.txt mark every coming item and never mark a live one', () => {
    for (const f of ['llms.txt', 'llms-full.txt']) {
      const t = pub(f);
      for (const id of coming) {
        const title = CAPABILITIES.en[id].t;
        const line = t.split('\n').find(l => l.includes(title) && /^(- |### )/.test(l));
        expect(line, `${f} lists ${title}`).toBeTruthy();
        if (f === 'llms.txt') expect(line).toMatch(/coming soon/);
        else
          expect(t.slice(t.indexOf(`### ${title}`), t.indexOf(`### ${title}`) + 200)).toMatch(
            /coming soon/
          );
      }
      for (const id of live) {
        const title = CAPABILITIES.en[id].t;
        const line = t.split('\n').find(l => l.includes(title) && /^(- |### )/.test(l));
        if (line && f === 'llms.txt') expect(line).not.toMatch(/coming soon/);
      }
    }
  });
});
