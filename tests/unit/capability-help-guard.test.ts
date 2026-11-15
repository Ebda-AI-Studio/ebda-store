import { describe, expect, it } from 'vitest';
import { checkHelp } from '../../packages/shared/src/foundation/help-article';
import { readConfig } from '../helpers/capability-facts';
import { idsOf, judge, loadBaseline, loadRegistry } from '../helpers/capability-guard';
import { helpArticles, rawArticles } from '../helpers/help-articles';
// @ts-expect-error plain .mjs build helper
import { buildManifest, contentHash } from '../../apps/help/scripts/help-manifest.mjs';

const cfg = readConfig();
const { entries } = loadRegistry(cfg);

describe('capability help guard: every live merchant-facing capability has a linked, fresh ar+en article', () => {
  it('loads the published articles from both languages', () => {
    const articles = helpArticles();
    expect(articles.filter(a => a.lang === 'ar').length).toBe(
      articles.filter(a => a.lang === 'en').length
    );
    expect(articles.length).toBeGreaterThanOrEqual(60);
  });

  it('has no new help violation and no stale baseline id (the 71 needs-help ids are the debt)', () => {
    const r = judge('help', checkHelp(entries, helpArticles(), cfg));
    expect(r.failures).toEqual([]);
  });

  it('the help baseline contains only ids that currently violate', () => {
    const current = new Set(idsOf(checkHelp(entries, helpArticles(), cfg)));
    expect(loadBaseline('help').filter(id => !current.has(id))).toEqual([]);
  });

  it('an article present in one language only fails (mutation proof)', () => {
    const articles = helpArticles().filter(a => !(a.slug === 'orders-and-cod' && a.lang === 'en'));
    expect(
      checkHelp(entries, articles, cfg).some(
        v => v.rule === 'help-twin-missing' && v.key === 'orders-and-cod'
      )
    ).toBe(true);
  });

  it('an article that lost its capabilities link fails help-unlinked (mutation proof)', () => {
    const articles = helpArticles().map(a =>
      a.slug === 'orders-and-cod' ? { ...a, capabilities: [] } : a
    );
    expect(checkHelp(entries, articles, cfg).some(v => v.rule === 'help-unlinked')).toBe(true);
  });
});

describe('help-manifest.json', () => {
  it('lists every article in both languages with capabilities as id@version', () => {
    const raws = rawArticles();
    const m = buildManifest(
      raws.map(a => ({ ...a, body: a.raw })),
      '2026-11-14T00:00:00.000Z'
    );
    expect(m.articles).toHaveLength(raws.length);
    const orders = m.articles.filter((a: { slug: string }) => a.slug === 'orders-and-cod');
    expect(orders.map((a: { lang: string }) => a.lang).sort()).toEqual(['ar', 'en']);
    expect(orders[0].capabilities).toContain('order.update-status@1');
    expect(orders[0].appPath).toBe('/stores');
  });

  it('contentHash is pinned (the publication-lag check in other repos copies this algorithm)', () => {
    expect(contentHash('hello\r\nworld\n')).toBe(
      '26c60a61d01db5836ca70fefd44a6a016620413c8ef5f259a6c5612d4f79d3b8'
    );
    expect(contentHash('  x  ')).toBe(contentHash('x'));
  });
});
