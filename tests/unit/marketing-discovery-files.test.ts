import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import robots, { AI_CRAWLERS } from '../../apps/marketing/src/app/robots';

/** The discovery files of ebda.app (site trust standard): llms.txt, the /llm.txt alias, robots, security.txt. */
const PUB = path.resolve(__dirname, '../../apps/marketing/public');
const read = (f: string) => readFileSync(path.join(PUB, f), 'utf8');

describe('discovery files', () => {
  it('robots names the search and AI crawlers, allows everything and carries the Sitemap line', () => {
    const r = robots();
    const rules = Array.isArray(r.rules) ? r.rules : [r.rules];
    for (const bot of ['GPTBot', 'OAI-SearchBot', 'ClaudeBot', 'PerplexityBot', 'Google-Extended'])
      expect(AI_CRAWLERS).toContain(bot);
    for (const bot of AI_CRAWLERS)
      expect(rules.find(x => x.userAgent === bot)?.allow, bot).toBe('/');
    expect(rules.some(x => x.disallow)).toBe(false);
    expect(r.sitemap).toBe('https://ebda.app/sitemap.xml');
  });

  it('security.txt: Contact, canonical, and an Expires at least 90 days away (RFC 9116)', () => {
    for (const f of ['.well-known/security.txt']) {
      const t = read(f);
      expect(t).toMatch(/^Contact: mailto:security@ebda\.app$/m);
      expect(t).toMatch(/^Canonical: https:\/\/ebda\.app\/\.well-known\/security\.txt$/m);
      const exp = new Date(/^Expires: (.+)$/m.exec(t)![1]);
      expect(exp.getTime() - Date.now()).toBeGreaterThan(90 * 86_400_000);
    }
  });

  it('llms.txt describes the current product: all five templates, the editor, and names no provider', () => {
    const t = read('llms.txt');
    for (const w of ['Qamar', 'Souq', 'Jasmine', 'Lamma', 'Dahab', 'visual editor'])
      expect(t, w).toContain(w);
    expect(t).not.toMatch(
      /Cloudflare|Gemini|Neon|Railway|Vercel|Inngest|Postgres|OpenAI|Anthropic/i
    );
    expect(t).not.toMatch(/Ebda(?! (Store|AI Studio|Chat))\b/);
  });

  it('/llm.txt is a 301 alias of /llms.txt', () => {
    expect(existsSync(path.join(PUB, 'llms.txt'))).toBe(true);
    expect(read('_redirects')).toMatch(/^\/llm\.txt\s+\/llms\.txt\s+301$/m);
  });
});
