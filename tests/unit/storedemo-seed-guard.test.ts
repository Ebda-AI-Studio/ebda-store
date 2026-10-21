import { describe, it, expect } from 'vitest';
import {
  guard,
  isLocalUrl,
  describePlan,
  assetBase,
  videoUrl,
  variantSku,
  PHASE_S_PLACEHOLDERS,
  PLACEHOLDER_SLUGS,
  // @ts-expect-error plain .mjs script
} from '../../scripts/storedemo/seed.mjs';
// @ts-expect-error plain .mjs data module
import { QAMAR_PRODUCTS } from '../../scripts/qamar-demo/catalogue.mjs';

// Built from parts so secretlint does not read a fixture as a leaked connection string.
const pg = (rest: string) => ['postgresql', '://', rest].join('');

describe('storedemo seed guard', () => {
  it('allows loopback hosts', () => {
    for (const u of [pg('a:b@localhost:5432/x'), pg('a:b@127.0.0.1/x'), pg('a:b@[::1]:5432/x')])
      expect(guard(u, []).ok).toBe(true);
  });
  it('refuses a remote host unless --yes-production', () => {
    const remote = pg('a:b@ep-x.eu-central-1.aws.neon.tech/db');
    expect(isLocalUrl(remote)).toBe(false);
    expect(guard(remote, []).ok).toBe(false);
    expect(guard(remote, ['--allow-remote']).ok).toBe(false);
    expect(guard(remote, ['--yes-production']).ok).toBe(true);
  });
  it('refuses a ?host= / ?hostaddr= override that points the driver at another host', () => {
    for (const u of [
      pg('a:b@localhost:5432/x?host=ep-x.neon.tech'),
      pg('a:b@localhost/x?hostaddr=203.0.113.7'),
      pg('a:b@/x?host=/var/run/postgresql'),
    ]) {
      expect(isLocalUrl(u)).toBe(false);
      expect(guard(u, []).ok).toBe(false);
    }
  });
  it('treats a unix-socket authority as local', () => {
    expect(isLocalUrl(pg('a:b@%2Fvar%2Frun%2Fpostgresql/x'))).toBe(true);
    expect(guard(pg('a:b@%2Fvar%2Frun%2Fpostgresql/x'), []).ok).toBe(true);
  });
  it('refuses a missing or invalid url', () => {
    expect(guard(undefined, ['--yes-production']).ok).toBe(false);
    expect(guard('not a url', ['--yes-production']).ok).toBe(false);
  });
  it('the plan names the host and the counts, and never the credentials', () => {
    const plan = describePlan(pg('user:secretpw@localhost:5432/x'));
    expect(plan).toContain('localhost');
    expect(plan).not.toContain('secretpw');
    expect(plan).toContain(`qamar: ${QAMAR_PRODUCTS.length} products`);
  });
  it('production run refuses any asset base but media.ebda.app/demo/qamar (Ruling B1-16)', () => {
    expect(
      assetBase(['--yes-production'], { QAMAR_DEMO_ASSET_BASE: 'http://localhost:9000' }).ok
    ).toBe(false);
    expect(
      assetBase(['--yes-production'], { QAMAR_DEMO_ASSET_BASE: 'https://pub-x.r2.dev/demo/qamar' })
        .ok
    ).toBe(false);
    expect(assetBase(['--yes-production'], {}).ok).toBe(true); // default
    expect(assetBase(['--yes-production'], {}).base).toBe('https://media.ebda.app/demo/qamar');
    expect(assetBase([], { QAMAR_DEMO_ASSET_BASE: 'http://localhost:9000' }).base).toBe(
      'http://localhost:9000'
    );
  });
  it('the hero clip is only ever an https or relative URL (the hero video schema)', () => {
    expect(videoUrl('https://media.ebda.app/demo/qamar')).toBe(
      'https://media.ebda.app/demo/qamar/hero.mp4'
    );
    expect(videoUrl('/__qamar-demo')).toBe('/__qamar-demo/hero.mp4');
    expect(videoUrl('http://localhost:9000')).toBeNull();
  });
  it('describePlan names the Qamar catalogue and the archived placeholder families (C3)', () => {
    const plan = describePlan(pg('u@localhost/x'));
    expect(plan).toMatch(/qamar: \d+ products/);
    expect(plan).toContain('archived: fashion, electronics, beauty, home-kitchen, jewellery');
  });
  it('the archive list covers all five Phase S families, the fashion products included (C3)', () => {
    expect(PHASE_S_PLACEHOLDERS).toHaveLength(5);
    expect(PLACEHOLDER_SLUGS).toEqual(
      expect.arrayContaining(['linen-shirt', 'wide-trousers', 'wool-scarf', 'leather-belt'])
    );
    const qamar = new Set(QAMAR_PRODUCTS.map((p: { slug: string }) => p.slug));
    for (const s of PLACEHOLDER_SLUGS) expect(qamar.has(s), s).toBe(false);
  });
  it('variant SKUs use full value slugs, so lengths 56 and 58 never collide (C17)', () => {
    expect(variantSku('linen-abaya', ['Rose', 'M', '56'])).toBe('LINEN-ABAYA-ROSE-M-56');
    expect(variantSku('linen-abaya', ['Rose', 'M', '56'])).not.toBe(
      variantSku('linen-abaya', ['Rose', 'M', '58'])
    );
  });
});
