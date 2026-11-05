/**
 * Ruling DEPLOY-TIMEOUT-1: a hung deploy (OpenNext R2 populate retrying, 2026-11-03) holds the single self-hosted runner. Every job
 * in every cf-*-deploy workflow has timeout-minutes, and so does each "Deploy ..." step.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const DIR = path.resolve(__dirname, '../../.github/workflows');
const files = readdirSync(DIR).filter(f => /^cf-.*-deploy\.yml$/.test(f));

describe('deploy workflows bound their runtime', () => {
  it('finds the deploy workflows', () => {
    expect(files.length).toBeGreaterThanOrEqual(9);
  });
  it.each(files)('%s: every job has timeout-minutes', f => {
    const text = readFileSync(path.join(DIR, f), 'utf8');
    const jobsBlock = text.split(/^jobs:\n/m)[1] ?? '';
    const jobs = jobsBlock
      .split(/^(?= {2}[A-Za-z0-9_-]+:\n)/m)
      .filter(j => /^ {2}[A-Za-z0-9_-]+:\n/.test(j));
    expect(jobs.length).toBeGreaterThan(0);
    for (const j of jobs) {
      const name = j.trim().split(':')[0];
      expect(
        /^ {4}timeout-minutes:\s*\d+/m.test(j),
        `${f}: job ${name} has no timeout-minutes`
      ).toBe(true);
    }
  });
  it.each(files)('%s: the Deploy step has its own timeout-minutes', f => {
    const text = readFileSync(path.join(DIR, f), 'utf8');
    const steps = text
      .split(/^ {6}- name: /m)
      .slice(1)
      .filter(s => s.startsWith('Deploy '));
    expect(steps.length).toBeGreaterThan(0);
    for (const s of steps) {
      const body = s.split(/^ {6}- /m)[0];
      expect(
        /^ {8}timeout-minutes:\s*\d+/m.test(body),
        `${f}: step "${s.split('\n')[0]}" has no timeout-minutes`
      ).toBe(true);
    }
  });
});
