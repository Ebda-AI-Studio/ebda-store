// @vitest-environment jsdom
/** STOP-1 findings (Phase B2 Task 7 wave 1): shared newsletter privacy link target, Night hero asset. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup } from '@testing-library/react';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { smallTargets } from '../helpers/target-size';

vi.mock('../../apps/web/src/contexts/StoreContext', () => ({
  useStore: () => ({ store: { id: 's', slug: 's', isDemo: false, theme: {}, look: null } }),
  useStoreUrl: () => (p: string) => p,
  useStoreTheme: () => ({}),
}));
vi.mock('../../apps/web/src/contexts/LanguageContext', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useLanguage: () => ({
    language: 'en',
    isRtl: false,
    t: (en: string) => en,
  }),
}));
afterEach(cleanup);

const { NewsletterSection } = await import('../../apps/web/src/builder/sections/NewsletterSection');

describe('newsletter consent line (shared by every store)', () => {
  it('the Privacy policy link is a >= 44px target', () => {
    const { container, getByText } = render(<NewsletterSection settings={{}} />);
    const link = getByText('Privacy policy');
    expect(link.tagName).toBe('A');
    expect(link.className).toMatch(/\bmin-h-11\b/);
    expect(smallTargets(container, 44).filter(x => /Privacy/.test(x))).toEqual([]);
  });
});

describe('Night hero asset', () => {
  const root = path.resolve(__dirname, '../..');
  it('exists, is within budget and the source prompt names no device', () => {
    const f = path.join(root, 'scripts/souq-demo/assets/hero-night-2k.webp');
    expect(statSync(f).size).toBeLessThanOrEqual(140 * 1024);
    const prompts = readFileSync(path.join(root, 'scripts/souq-demo/prompts.py'), 'utf8');
    const hero = prompts.slice(
      prompts.indexOf("add('hero-night'"),
      prompts.indexOf("add('hero-showroom'")
    );
    expect(hero).toMatch(/no devices/);
    expect(hero).not.toMatch(/smartphone/);
  });
});

describe('Ruling B2-20: brass text on a card', () => {
  it('Night souq re-inks text-primary inside a card (brass is 3.65:1 on the surface)', () => {
    const css = readFileSync(
      path.resolve(__dirname, '../../apps/web/src/styles/globals.css'),
      'utf8'
    );
    const rule = /\[data-look='souq\.night'\] \.bg-card \.text-primary \{([^}]*)\}/.exec(css);
    expect(rule, 'the Night rule exists').not.toBeNull();
    expect(rule![1]).toMatch(/color:\s*hsl\(var\(--foreground\)\)/);
    expect(rule![1]).toMatch(/text-decoration:\s*underline/);
  });
});
