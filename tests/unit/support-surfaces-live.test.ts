import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * help.ebda.app, docs.ebda.app and status.ebda.app are each their own live host (6c): master-brand titles
 * (BRAND-ARCH-1), product sections, and their own sitemap, robots and security.txt. The deploy workflows ship
 * PRODUCTION only (Ruling INFRA-PREVIEW-1).
 */
const ROOT = path.resolve(__dirname, '../..');
const read = (...p: string[]) => readFileSync(path.join(ROOT, ...p), 'utf8');

describe.each([
  ['help', 'Ebda AI Studio Help', 'مركز مساعدة ابدأ استوديو للذكاء الاصطناعي'],
  ['docs', 'Ebda AI Studio Docs', 'وثائق ابدأ استوديو للذكاء الاصطناعي'],
] as const)('%s.ebda.app', (app, titleEn, titleAr) => {
  const out = (...p: string[]) => path.join(ROOT, 'apps', app, 'out', ...p);
  beforeAll(() => {
    execFileSync('npm', ['run', 'build', '-w', `apps/${app}`], { cwd: ROOT, stdio: 'pipe' });
  }, 120_000);

  it('is titled with the master brand, per product', () => {
    expect(read('apps', app, 'out', 'index.html')).toMatch(
      app === 'help' ? new RegExp(`<title>${titleAr}`) : new RegExp(`<title>${titleEn}`)
    );
    if (app === 'help') expect(read('apps/help/out/en/index.html')).toContain(`<title>${titleEn}`);
    if (app === 'docs') expect(read('apps/docs/out/ar/index.html')).toContain(titleAr);
    const home = read('apps', app, 'out', app === 'help' ? 'en/index.html' : 'index.html');
    expect(home).toContain('Ebda Store');
    // a product gets its section the day it ships (WhatsApp ships with Store); the shared header's Products menu (NAV-1) lists the live products
    const withoutNav = home.replace(/<nav class="top-nav"[\s\S]*?<\/nav>/, '');
    expect(withoutNav).not.toMatch(/Ebda (CRM|ERP)/);
  });

  it('has its own sitemap, robots and a security.txt with its own canonical', () => {
    expect(read('apps', app, 'out', 'sitemap.xml')).toContain(`https://${app}.ebda.app/`);
    expect(read('apps', app, 'out', 'robots.txt')).toContain(
      `Sitemap: https://${app}.ebda.app/sitemap.xml`
    );
    const sec = read('apps', app, 'out', '.well-known', 'security.txt');
    expect(sec).toContain(`Canonical: https://${app}.ebda.app/.well-known/security.txt`);
    expect(sec).toMatch(/^Contact: mailto:security@ebda\.app$/m);
    const exp = new Date(/^Expires: (.+)$/m.exec(sec)![1]).getTime();
    expect(exp - Date.now()).toBeGreaterThan(90 * 86_400_000);
    expect(existsSync(out('_headers'))).toBe(true);
  });

  it('deploys as its own Worker on its own custom domain, production only', () => {
    const w = read('apps', app, 'wrangler.jsonc');
    expect(w).toContain(`"name": "ebda-${app}"`);
    expect(w).toContain(`"pattern": "${app}.ebda.app", "custom_domain": true`);
    // the storefront wildcard runs before custom domains: only a specific zone route beats it (cf-routes.cjs)
    expect(w).toContain(`"pattern": "${app}.ebda.app/*", "zone_name": "ebda.app"`);
    expect(w).not.toMatch(/"env"|-preview|staging/i);
  });
});

describe('status Worker route', () => {
  it('claims its host with a custom domain AND the specific zone route that beats the wildcard', () => {
    const w = read('apps/status/wrangler.jsonc');
    expect(w).toContain('"pattern": "status.ebda.app", "custom_domain": true');
    expect(w).toContain('"pattern": "status.ebda.app/*", "zone_name": "ebda.app"');
  });
});

describe('deploy workflows (production only, verified after deploy)', () => {
  for (const app of ['help', 'docs', 'status']) {
    it(`cf-${app}-deploy.yml: main/dispatch only, guard probes the live host, no preview`, () => {
      const y = read('.github', 'workflows', `cf-${app}-deploy.yml`);
      expect(y).toContain(`ebda-${app}-production`);
      expect(y).toContain('environment: production');
      expect(y).toContain("github.ref == 'refs/heads/main'");
      expect(y).toContain('deploy-guard.mjs previous');
      expect(y).toContain(`--name ebda-${app}`);
      expect(y).toContain(`https://${app}.ebda.app/`);
      expect(y).toContain('--rollback-probe');
      expect(y).not.toMatch(/preview|staging|--env/i);
    });
  }
});

describe('help.ebda.app product folders (LAUNCH-SUITE-1)', () => {
  it('Ebda WhatsApp guides build at /whatsapp/<slug>/ in both locales, with a sidebar group and a home section', () => {
    const ar = readdirSync(path.join(ROOT, 'apps/help/content/ar/whatsapp')).filter(f =>
      f.endsWith('.mdx')
    );
    const en = readdirSync(path.join(ROOT, 'apps/help/content/en/whatsapp')).filter(f =>
      f.endsWith('.mdx')
    );
    expect(ar.length).toBe(13);
    expect(ar).toEqual(en); // parity: same slugs in both locales
    const out = (...p: string[]) => path.join(ROOT, 'apps/help/out', ...p);
    for (const f of ar) {
      const slug = f.replace(/\.mdx$/, '');
      expect(existsSync(out('whatsapp', slug, 'index.html')), `ar ${slug}`).toBe(true);
      expect(existsSync(out('en', 'whatsapp', slug, 'index.html')), `en ${slug}`).toBe(true);
    }
    const page = readFileSync(out('en', 'whatsapp', 'ai-agent', 'index.html'), 'utf8');
    expect(page).toContain('Ebda WhatsApp'); // eyebrow + sidebar group
    expect(readFileSync(out('index.html'), 'utf8')).toContain('id="p-whatsapp"');
    expect(readFileSync(out('sitemap.xml'), 'utf8')).toContain(
      'https://help.ebda.app/whatsapp/ai-agent/'
    );
    expect(readFileSync(out('sitemap.xml'), 'utf8')).toContain(
      'https://help.ebda.app/en/whatsapp/ai-agent/'
    );
  });
  it('guides keep no relative .md links and name no provider', () => {
    for (const lang of ['ar', 'en'])
      for (const f of readdirSync(path.join(ROOT, 'apps/help/content', lang, 'whatsapp'))) {
        const t = readFileSync(path.join(ROOT, 'apps/help/content', lang, 'whatsapp', f), 'utf8');
        expect(t, f).not.toMatch(/\]\([^)]*\.md[)#]/);
        expect(t, f).not.toMatch(/Cloudflare|Gemini|Neon|Railway|Inngest/i);
      }
  });
});
