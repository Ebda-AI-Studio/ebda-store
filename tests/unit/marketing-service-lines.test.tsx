/**
 * Service lines (Ruling SERVICES-IA-1): Marketing, Design and Events are pages of ebda.app under /services, hidden in
 * production behind ONE build flag (EBDA_SERVICE_LINES: off | preview | on). This pins every surface the flag moves together:
 * pages, nav, sitemap, llms.txt, JSON-LD, the home's coming-soon cards and on-the-ground band, the contact form topics, and the
 * noindex of a preview. Plus the content rules: Arabic first, "illustrative" captions, no provider names, no orange, no hexagram.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

vi.mock('next/font/google', () => {
  const font = () => ({ className: '', variable: '', style: {} });
  return { Geist: font, Geist_Mono: font, IBM_Plex_Sans_Arabic: font };
});

import { BRAND } from '../../packages/shared/src/brand';
import { CONTACT_TOPIC_IDS } from '../../packages/shared/src/contact-enquiry';
import { parseServiceLinesMode } from '../../apps/marketing/src/lib/service-lines';
import { SERVICE_LINE_CONTENT } from '../../apps/marketing/src/lib/service-lines-content';
import { pageMetadata, serviceLineJsonLd, studioJsonLd } from '../../apps/marketing/src/lib/seo';
import { ServiceLinePage } from '../../apps/marketing/src/components/ServiceLinePage';
import { ServicesIndexPage } from '../../apps/marketing/src/components/ServicesIndexPage';
import { StudioHomePage } from '../../apps/marketing/src/components/StudioHome';
import { Header } from '../../apps/marketing/src/components/Header';
import { comingSoonItems } from '../../apps/marketing/src/lib/coming-soon';
import {
  applyServiceLinesPostbuild,
  servicesLlmsBlock,
} from '../../apps/marketing/scripts/service-lines-postbuild';

const APP = path.resolve(__dirname, '../../apps/marketing');
const IDS = ['marketing', 'design', 'events'] as const;
const LOCALES = ['ar', 'en'] as const;
const html = (el: React.ReactElement) => renderToStaticMarkup(el);

afterEach(() => vi.unstubAllEnvs());

describe('the flag', () => {
  it.each([
    [undefined, 'off'],
    ['', 'off'],
    ['off', 'off'],
    ['nonsense', 'off'],
    ['preview', 'preview'],
    ['PREVIEW', 'preview'],
    ['on', 'on'],
    ['1', 'on'],
    ['true', 'on'],
  ])('%s -> %s', (raw, mode) => expect(parseServiceLinesMode(raw)).toBe(mode));

  it('the default (unset) is OFF: nothing is public', async () => {
    const { SITE_PAGES } = await import('../../apps/marketing/src/lib/site');
    expect(SITE_PAGES.some(p => p.startsWith('services'))).toBe(false);
    const tree = html(<Header locale="ar" page="" />);
    expect(tree).not.toContain('/services/');
    const home = html(<StudioHomePage locale="ar" />);
    expect(home).not.toContain('data-coming-soon');
    expect(home).not.toContain('on-the-ground');
    expect(JSON.stringify(studioJsonLd('en'))).not.toMatch(/Marketing|Events|Design/);
    expect(pageMetadata('ar', 'services/marketing').robots).toEqual({
      index: false,
      follow: false,
    });
  });
});

describe('ON publishes everything together', () => {
  it('sitemap, nav, home band, coming-soon cards, JSON-LD and llms block all appear', async () => {
    vi.stubEnv('EBDA_SERVICE_LINES', 'on');
    vi.resetModules();
    const { SITE_PAGES, SERVICE_PAGES } = await import('../../apps/marketing/src/lib/site');
    expect(SERVICE_PAGES).toHaveLength(4);
    for (const p of SERVICE_PAGES) expect(SITE_PAGES).toContain(p);
    const sitemap = (await import('../../apps/marketing/src/app/sitemap')).default;
    const urls = sitemap().map(e => e.url);
    for (const u of [
      '/services/',
      '/en/services/',
      ...IDS.flatMap(i => [`/services/${i}/`, `/en/services/${i}/`]),
    ])
      expect(urls, u).toContain(`https://ebda.app${u}`);
    const { Header: H } = await import('../../apps/marketing/src/components/Header');
    for (const l of LOCALES) {
      const nav = html(<H locale={l} page="" />);
      expect(nav).toMatch(l === 'ar' ? /href="\/services\/?"/ : /href="\/en\/services\/?"/);
    }
    const { StudioHomePage: Home } = await import('../../apps/marketing/src/components/StudioHome');
    const home = html(<Home locale="en" />);
    expect(home).toContain('on-the-ground');
    for (const id of ['quote-studio', 'invite', 'ads'])
      expect(home).toContain(`data-coming-soon="${id}"`);
    expect(home).toMatch(/\/en\/contact\/?\?topic=products#form/);
    const seo = await import('../../apps/marketing/src/lib/seo');
    expect(JSON.stringify(seo.studioJsonLd('en'))).toContain('/en/services/marketing/');
    expect(seo.pageMetadata('en', 'services/design').robots).toEqual({ index: true, follow: true });
    expect(servicesLlmsBlock()).toContain('/en/services/events/');
  });
});

describe('names and the header dropdowns', () => {
  it('every product and service has an Arabic and an English name, from BRAND', () => {
    expect(BRAND.serviceLines.map(l => [l.nameEn, l.nameAr])).toEqual([
      ['Ebda Marketing', 'ابدأ ماركتنج'],
      ['Ebda Design', 'ابدأ ديزاين'],
      ['Ebda Events', 'ابدأ إيفنتس'],
    ]);
    expect(BRAND.comingProducts.map(p => [p.nameEn, p.nameAr])).toEqual([
      ['Ebda Quote Studio', 'ابدأ استوديو للتسعير'],
      ['Ebda Invite', 'ابدأ إنفايت'],
      ['Ebda Ads', 'ابدأ آدز'],
    ]);
    // «كوت» reads as "coat" in Egyptian Arabic (Ahmad 2026-11-09)
    expect(JSON.stringify(BRAND.comingProducts)).not.toContain('كوت');
  });

  it('OFF: no Services dropdown and no coming-soon rows in the header', () => {
    for (const l of LOCALES) {
      const t = html(<Header locale={l} page="" />);
      expect(t).not.toContain('nav-services');
      expect(t).not.toContain('np-soon');
    }
  });

  it('ON: Services dropdown (core, Events, Marketing, Design, All services) after Products, and Products lists the coming-soon software', async () => {
    vi.stubEnv('EBDA_SERVICE_LINES', 'on');
    vi.resetModules();
    const { Header: H } = await import('../../apps/marketing/src/components/Header');
    for (const l of LOCALES) {
      const t = html(<H locale={l} page="" />);
      const names = BRAND.serviceLines.map(x => (l === 'ar' ? x.nameAr : x.nameEn));
      for (const n of names) expect(t).toContain(n);
      expect(t.indexOf('nav-services')).toBeGreaterThan(t.indexOf('nav-products'));
      expect(t.indexOf('nav-services')).toBeLessThan(
        t.indexOf('>' + (l === 'ar' ? 'المصادر' : 'Resources') + '<')
      );
      expect(t).toMatch(/services\/?#core/);
      expect((t.match(/np-soon/g) ?? []).length).toBeGreaterThanOrEqual(3);
      for (const p of BRAND.comingProducts) expect(t).toContain(l === 'ar' ? p.nameAr : p.nameEn);
      expect(t).toContain(l === 'ar' ? 'قريبًا' : 'Coming soon');
    }
  });
});

describe('PREVIEW: pages exist for Ahmad, but stay unlisted and noindex', () => {
  it('nothing is in the sitemap or nav, and the pages say noindex', async () => {
    vi.stubEnv('EBDA_SERVICE_LINES', 'preview');
    vi.resetModules();
    const { SITE_PAGES } = await import('../../apps/marketing/src/lib/site');
    expect(SITE_PAGES.some(p => p.startsWith('services'))).toBe(false);
    const { Header: H } = await import('../../apps/marketing/src/components/Header');
    expect(html(<H locale="ar" page="" />)).not.toContain('/services/');
    const seo = await import('../../apps/marketing/src/lib/seo');
    for (const id of IDS)
      expect(seo.pageMetadata('en', `services/${id}`).robots).toEqual({
        index: false,
        follow: false,
      });
    const { comingSoonItems: items } = await import('../../apps/marketing/src/lib/coming-soon');
    expect(items('ar')).toEqual([]);
  });
});

describe('post-build step', () => {
  const mk = () => {
    const out = mkdtempSync(path.join(tmpdir(), 'svc-'));
    for (const d of ['services/marketing', 'en/services/design']) {
      mkdirSync(path.join(out, d), { recursive: true });
      writeFileSync(path.join(out, d, 'index.html'), 'x');
    }
    writeFileSync(path.join(out, 'llms.txt'), '# Ebda\n');
    return out;
  };
  it('off deletes the exported pages (a 404, never a 200 with a not-found body)', () => {
    const out = mk();
    applyServiceLinesPostbuild(out, 'off');
    expect(existsSync(path.join(out, 'services'))).toBe(false);
    expect(existsSync(path.join(out, 'en/services'))).toBe(false);
    expect(readFileSync(path.join(out, 'llms.txt'), 'utf8')).not.toContain('Services');
  });
  it('preview keeps the pages and adds nothing to llms.txt; on appends the block once', () => {
    const out = mk();
    applyServiceLinesPostbuild(out, 'preview');
    expect(existsSync(path.join(out, 'services/marketing/index.html'))).toBe(true);
    expect(readFileSync(path.join(out, 'llms.txt'), 'utf8')).toBe('# Ebda\n');
    vi.stubEnv('EBDA_SERVICE_LINES', 'on');
    applyServiceLinesPostbuild(out, 'on');
    applyServiceLinesPostbuild(out, 'on');
    const t = readFileSync(path.join(out, 'llms.txt'), 'utf8');
    expect(t.match(/## Services/g)).toHaveLength(1);
    expect(t).toContain('Ebda Invite');
  });
});

describe.each(LOCALES)('pages (%s)', locale => {
  it('the Services index lists the core FIRST, then the three lines as links', () => {
    const t = html(<ServicesIndexPage locale={locale} />);
    const core = t.indexOf('data-service="software"');
    const lines = t.indexOf('data-service-line="marketing"');
    expect(core).toBeGreaterThan(0);
    expect(lines).toBeGreaterThan(core);
    for (const s of BRAND.services) expect(t).toContain(`data-service="${s.id}"`);
    for (const id of IDS)
      expect(t).toMatch(new RegExp(`href="${locale === 'ar' ? '' : '/en'}/services/${id}/?"`));
    expect(t.match(/<h1/g)).toHaveLength(1);
  });

  it.each(IDS)(
    '%s: one rich page with every section, a contact CTA with its topic, and the email',
    id => {
      const t = html(<ServiceLinePage locale={locale} id={id} />);
      expect(t.match(/<h1/g)).toHaveLength(1);
      for (const sec of [
        'sv-hero',
        'sv-pathsec',
        'id="what"',
        'id="how"',
        'id="why"',
        'id="faq"',
        'id="contact"',
      ])
        expect(t, sec).toContain(sec);
      expect(t).toMatch(new RegExp(`/contact/?\\?topic=${id}#form`));
      expect(t).toContain(BRAND.supportEmail);
      expect(t).toContain(`sv sv-${id}`);
      // every generated photo says it is illustrative, and its files exist
      const c = SERVICE_LINE_CONTENT[id];
      expect((t.match(/<figcaption/g) ?? []).length).toBe(3);
      expect(t).toContain(locale === 'ar' ? 'صورة توضيحية' : 'Illustrative image');
      for (const n of Object.values(c.images))
        for (const w of [640, n.endsWith('hero') ? 832 : 1216])
          expect(existsSync(path.join(APP, `public/services/${n}-${w}.webp`)), `${n}-${w}`).toBe(
            true
          );
      // a service company, not a software pitch: the software note is a footnote, and no prices appear
      expect(t).toContain(`data-powered="${id}"`);
      expect(t).not.toMatch(/\bEGP\s?\d|\d\s?(جنيه|EGP)/);
    }
  );

  it('the line JSON-LD is a Service under the studio plus the page FAQ', () => {
    const ld = serviceLineJsonLd(locale, 'events') as { '@graph': { '@type': string }[] };
    expect(ld['@graph'].map(n => n['@type'])).toEqual(['Service', 'FAQPage']);
  });
});

describe('coming-soon cards (software only, names distinct from the services)', () => {
  it('are empty unless published, and name software products, never the on-the-ground services', async () => {
    expect(comingSoonItems('en')).toEqual([]);
    vi.stubEnv('EBDA_SERVICE_LINES', 'on');
    const names = comingSoonItems('en').map(i => i.name);
    expect(names).toEqual(['Ebda Quote Studio', 'Ebda Invite', 'Ebda Ads']);
    expect(comingSoonItems('ar').map(i => i.name)).toEqual([
      'ابدأ استوديو للتسعير',
      'ابدأ إنفايت',
      'ابدأ آدز',
    ]);
    for (const i of comingSoonItems('en'))
      expect(i.blurb + i.facts.join(' ')).not.toMatch(/\d{4}|EGP \d|waitlist/i);
  });
});

describe('contact topics', () => {
  it('the API contract accepts marketing, design, events and products; the core list is unchanged', () => {
    for (const t of [...IDS, 'products'])
      expect(CONTACT_TOPIC_IDS as readonly string[]).toContain(t);
    expect(BRAND.services.map(s => s.id)).toEqual(['software', 'ai', 'training']);
  });
});

describe('content rules', () => {
  const ALL =
    JSON.stringify(SERVICE_LINE_CONTENT) +
    readFileSync(path.join(APP, 'src/lib/services-page.ts'), 'utf8');
  it('names no provider and no technology', () => {
    expect(ALL).not.toMatch(/cloudflare|workers\s*ai|gemini|openai|\bclaude|anthropic|pgvector/i);
  });
  it('no orange, no six-pointed star in the new styles', () => {
    const css = readFileSync(path.join(APP, 'src/app/services.css'), 'utf8');
    expect(css).not.toMatch(/#ff6e01|orange|hexagram|✡/i);
  });
  it('weddings only as support in Events, and no birthday service', () => {
    const ev = JSON.stringify(SERVICE_LINE_CONTENT.events);
    expect(ev).not.toMatch(/birthday|عيد ميلاد/i);
  });
});
