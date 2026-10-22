/** Ruling B2-7: one map, template -> demo store host; nothing else decides which demo store a template has. */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DEMO_HOSTS, demoHostFor, demoTemplates } from '../../apps/web/src/lib/demo-hosts';
import { unknownHostLinks } from '../../apps/web/src/lib/unknown-store-page';
// @ts-expect-error plain .mjs script
import { TEMPLATE_SPECS } from '../../scripts/storedemo/seed.mjs';

describe('demo host map', () => {
  it('is Qamar -> storedemo, Souq -> storedemo-souq, Jasmine -> storedemo-jasmine, Lamma -> storedemo-lamma', () => {
    expect(DEMO_HOSTS).toEqual({
      qamar: 'storedemo',
      souq: 'storedemo-souq',
      jasmine: 'storedemo-jasmine',
      lamma: 'storedemo-lamma',
    });
    expect(demoTemplates()).toEqual(['qamar', 'souq', 'jasmine', 'lamma']);
  });
  it('agrees with the seed: each spec slug is the host label of its template', () => {
    for (const t of demoTemplates()) expect(TEMPLATE_SPECS[t].slug).toBe(DEMO_HOSTS[t]);
  });
  it('builds the other template host from the current apex and port', () => {
    expect(demoHostFor('souq', 'storedemo.ebda.app')).toBe('storedemo-souq.ebda.app');
    expect(demoHostFor('qamar', 'storedemo-souq.ebda.app')).toBe('storedemo.ebda.app');
    expect(demoHostFor('souq', 'storedemo.preview.ebda.app:3000')).toBe(
      'storedemo-souq.preview.ebda.app:3000'
    );
    // Phase B3: the third demo store, from any of the other two
    expect(demoHostFor('jasmine', 'storedemo.ebda.app')).toBe('storedemo-jasmine.ebda.app');
    expect(demoHostFor('jasmine', 'storedemo-souq.ebda.app:3000')).toBe(
      'storedemo-jasmine.ebda.app:3000'
    );
    expect(demoHostFor('qamar', 'storedemo-jasmine.ebda.app')).toBe('storedemo.ebda.app');
    // Phase B4: the fourth demo store, from any of the others (Ruling B4-10)
    expect(demoHostFor('lamma', 'storedemo.ebda.app')).toBe('storedemo-lamma.ebda.app');
    expect(demoHostFor('lamma', 'storedemo-jasmine.preview.ebda.app:3000')).toBe(
      'storedemo-lamma.preview.ebda.app:3000'
    );
    expect(demoHostFor('souq', 'storedemo-lamma.ebda.app')).toBe('storedemo-souq.ebda.app');
  });
  it('is null off a demo host, for an unknown template, and for an empty host', () => {
    expect(demoHostFor('souq', 'localhost:3000')).toBeNull();
    expect(demoHostFor('souq', 'mystore.ebda.app')).toBeNull();
    expect(demoHostFor('souq', 'storedemo')).toBeNull();
    expect(demoHostFor('souq', '')).toBeNull();
    // a template with no demo store yet stays put
    expect(demoHostFor('dahab', 'storedemo.ebda.app')).toBeNull();
    expect(demoHostFor('dahab', 'storedemo-jasmine.ebda.app')).toBeNull();
  });
  it('the unknown-store 404 link reads the map, not a literal', () => {
    expect(unknownHostLinks({ SHOW_DEMO_STORE_LINK: 'true' }).demoStoreHref).toBe(
      `https://${DEMO_HOSTS.qamar}.ebda.app`
    );
    expect(
      readFileSync(path.resolve(__dirname, '../../apps/web/src/lib/unknown-store-page.ts'), 'utf8')
    ).toContain('DEMO_HOSTS.qamar');
  });
});
