/**
 * Ebda is AI-native and speaks in outcomes: the marketing app and its llms files never name the
 * providers or the technology behind a feature (Ahmad 2026-10-21). Scope: apps/marketing/src and
 * apps/marketing/public/llms*.txt. Tests, scripts and docs are not shipped copy.
 *
 * ALLOWED lists the two places where a name is required, not marketing: the legal documents' sub-processor
 * list (a disclosure duty) and robots.ts, whose crawler user-agent tokens must be the crawlers' real names.
 * Every entry must still contain a hit (last test), so the list can only shrink.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const APP = path.resolve(__dirname, '../../apps/marketing');
const BANNED =
  /cloudflare|workers\s*ai|gemini|pgvector|vector\s+database|embedding|openai|\bclaude/i;

const ALLOWED: Record<string, string> = {
  'src/lib/legal-en.ts': 'sub-processor disclosure (legal duty)',
  'src/lib/legal-ar.ts': 'sub-processor disclosure (legal duty)',
  'src/lib/legal-privacy-stack.ts': 'post-cutover sub-processor disclosure (legal duty)',
  'src/lib/legal-wa-en.ts': 'Ebda Chat DPA sub-processor list (generated from the legal source)',
  'src/lib/legal-wa-ar.ts': 'Ebda Chat DPA sub-processor list (generated from the legal source)',
  'src/app/robots.ts': 'crawler user-agent tokens (GPTBot, ClaudeBot) must be the real names',
};

const walk = (d: string): string[] =>
  readdirSync(d).flatMap(f => {
    const p = path.join(d, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

const files = [
  ...walk(path.join(APP, 'src')).filter(f => /\.(ts|tsx|css)$/.test(f)),
  path.join(APP, 'public/llms.txt'),
  path.join(APP, 'public/llms-full.txt'),
];
const rel = (f: string) => path.relative(APP, f);

describe('no provider or technology names in shipped marketing copy', () => {
  it('scans a sensible number of files', () => expect(files.length).toBeGreaterThan(30));
  for (const f of files.filter(f => !(rel(f) in ALLOWED))) {
    it(rel(f), () => {
      const hit = readFileSync(f, 'utf8').match(BANNED);
      expect(hit, `${rel(f)} names "${hit?.[0]}"`).toBeNull();
    });
  }
  it('every allowlisted file still needs its exception', () => {
    for (const k of Object.keys(ALLOWED))
      expect(readFileSync(path.join(APP, k), 'utf8')).toMatch(BANNED);
  });
});
