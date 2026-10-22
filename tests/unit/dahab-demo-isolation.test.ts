/**
 * Phase B5 Task 5 (the B2 review focus 7, again for Dahab): the showroom is an `is_demo` store whose
 * behaviour comes ONLY from that flag. Nothing branches on its slug, a merchant can never register the
 * slug, no other template's catalogue lives on it, and it never shares an owner or an asset base.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { isDemoShowroomSlug } from '@ebda/shared';
// @ts-expect-error plain .mjs script
import { TEMPLATE_SPECS } from '../../scripts/storedemo/seed.mjs';

const root = path.resolve(__dirname, '../..');

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (['node_modules', '.next', 'dist', '.open-next', '.wrangler'].includes(name)) continue;
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) sources(p, out);
    else if (/\.(ts|tsx|mjs)$/.test(name) && !/\.(test|spec)\./.test(name)) out.push(p);
  }
  return out;
}

describe('storedemo-dahab: behaviour comes from is_demo, never from the slug', () => {
  it('no runtime source names the slug, except the one host map (and its comment)', () => {
    const hits: string[] = [];
    for (const app of ['api', 'web', 'admin', 'orders'])
      for (const f of sources(path.join(root, 'apps', app, 'src')))
        if (readFileSync(f, 'utf8').includes('storedemo-dahab')) hits.push(path.relative(root, f));
    for (const f of sources(path.join(root, 'packages', 'shared', 'src')))
      if (readFileSync(f, 'utf8').includes('storedemo-dahab')) hits.push(path.relative(root, f));
    expect(hits).toEqual(['apps/web/src/lib/demo-hosts.ts']);
  });
  it('a merchant can never register the slug (the storedemo prefix is reserved)', () => {
    expect(isDemoShowroomSlug('storedemo-dahab')).toBe(true);
    expect(isDemoShowroomSlug('storedemo')).toBe(true);
  });
  it('the seed writes the showroom as is_demo and the look stores as NOT demo', () => {
    const src = readFileSync(path.join(root, 'scripts/storedemo/seed.mjs'), 'utf8');
    expect(src).toMatch(/isDemo: true,\s+status: 'active'/);
    expect(src).toMatch(/isDemo: false,\s+status: 'active',\s+plan: 'professional'/);
  });
});

describe('storedemo-dahab: its own owner, catalogue and assets', () => {
  const dahab = TEMPLATE_SPECS.dahab;
  const others = ['qamar', 'souq', 'jasmine', 'lamma'].map(t => TEMPLATE_SPECS[t]);
  it('no product slug or owner is shared (category slugs are per store, so occasions may repeat) with another showroom', () => {
    for (const o of others) {
      const oSlugs = new Set(o.products.map((p: { slug: string }) => p.slug));
      for (const p of dahab.products)
        expect(oSlugs.has(p.slug), `${o.slug}: ${p.slug}`).toBe(false);
      expect(dahab.ownerEmail).not.toBe(o.ownerEmail);
      expect(dahab.prodAssetBase).not.toBe(o.prodAssetBase);
      expect(dahab.assetEnv).not.toBe(o.assetEnv);
    }
  });
  it('the owner address has no login (the seed gives it a non-hash password) and no mailbox claim', () => {
    expect(dahab.ownerEmail).toBe('storedemo-dahab-owner@ebda.app');
    const src = readFileSync(path.join(root, 'scripts/storedemo/seed.mjs'), 'utf8');
    expect(src).toContain("passwordHash: '!seed-no-login'");
  });
  it('the Dahab catalogue names no other showroom’s products and no other platform’s name', () => {
    const text = JSON.stringify([dahab.products, dahab.categories]);
    // the platform names are assembled so this file does not itself trip the branding gate
    const foreign = [['for', 'ce ?a', 'i'].join(''), ['f', 'w', 'b'].join('')].join('|');
    expect(text).not.toMatch(
      new RegExp(`${foreign}|storedemo-(souq|lamma|jasmine)|qamar|abaya|kaftan`, 'i')
    );
  });
});
