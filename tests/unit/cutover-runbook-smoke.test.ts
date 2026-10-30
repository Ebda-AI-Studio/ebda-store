/** Opus M2: the cutover smoke (runbook 8.4) exercises a logged-in shopper and a webhook + job, not only a guest cart. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const rb = readFileSync(path.resolve(__dirname, '../../docs/runbooks/cutover-cf.md'), 'utf8');
const smoke = rb.slice(rb.indexOf('### 8.4 Smoke'), rb.indexOf('### 8.5'));

describe('cutover runbook smoke (8.4)', () => {
  it('has a logged-in shopper row that treats CUSTOMER_NOT_FOUND as a rollback trigger', () => {
    expect(smoke).toMatch(/Logged-in shopper/);
    expect(smoke).toMatch(/CUSTOMER_NOT_FOUND/);
  });
  it('has a staging-only sandbox payment + webhook + job row and never pays in production', () => {
    expect(smoke).toMatch(/STAGING ONLY/);
    expect(smoke).toMatch(/signed test webhook/);
    expect(smoke).toMatch(/Production is never paid/);
  });
  it('the day 0-7 check and 8.3 agree: a refused job is a finding, not a design', () => {
    expect(rb).toMatch(/no job is refused/);
    expect(rb).toMatch(/refused for DO store/);
  });
  it('8.3 pins STORE_DO_ENABLED_IDS to the flipped set until r6b removes the list (Opus C3 interim)', () => {
    const s83 = rb.slice(rb.indexOf('### 8.3'), rb.indexOf('### 8.4'));
    expect(s83).toMatch(/STORE_DO_ENABLED_IDS/);
    expect(s83).toMatch(/EXACTLY the flipped store ids/);
  });
});
