/**
 * Ruling DEPLOY-OOM-1: a deploy workflow that runs tsc or a build with Node's default heap can die with exit 134 and leave main
 * undeployed (cf-api-deploy, 2026-11-02). Every cf-*-deploy workflow sets NODE_OPTIONS --max-old-space-size >= 4096 at workflow
 * level, which covers every step of every job (typecheck, build, tests, wrangler).
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const DIR = path.resolve(__dirname, '../../.github/workflows');
const files = readdirSync(DIR).filter(f => /^cf-.*-deploy\.yml$/.test(f));

describe('deploy workflows set a Node heap', () => {
  it('finds the deploy workflows', () => {
    expect(files.length).toBeGreaterThanOrEqual(9);
  });
  it.each(files)('%s sets workflow-level NODE_OPTIONS --max-old-space-size >= 4096', f => {
    const text = readFileSync(path.join(DIR, f), 'utf8');
    const env = text.match(/^env:\n((?:[ ]{2}.*\n|\n)*)/m)?.[1] ?? '';
    const m = env.match(/^ {2}NODE_OPTIONS:\s*.*--max-old-space-size=(\d+)/m);
    expect(m, `${f}: no top-level env NODE_OPTIONS with --max-old-space-size`).toBeTruthy();
    expect(Number(m![1])).toBeGreaterThanOrEqual(4096);
  });
});
