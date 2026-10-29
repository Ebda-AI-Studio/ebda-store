import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The Ebda WhatsApp developer docs on docs.ebda.app/whatsapp/ equal their source (ebda-whatsapp docs/site/{ar,en}/whatsapp,
 * vendored verbatim in apps/docs/wa-source/ by `node apps/docs/scripts/import-wa-docs.mjs <docs/site>`). PINNED_SHA256 pins
 * each vendored file to the version the WhatsApp session published: when they ship new text, re-import and update the
 * hashes together. The word comparison fails if a published page differs from its source (link targets and the dropped H1 aside).
 */
const DOCS = path.resolve(__dirname, '../../apps/docs');
const PINNED_SHA256: Record<string, string> = {
  'ar/api.mdx': 'a3712b8af84955e569df2b577d30078158249828e5a16e23e31050b8c5cb0466',
  'ar/connect-your-number.mdx': '3f08b05f660be0db53df72dfff6d5acd5a487f981547aecaf26a47a710c06c21',
  'ar/overview.mdx': '29894ec202e7c3f66347a2deb13ba0c61d0f0b67ca6e07eb0c5ef0e20402a526',
  'ar/webhooks.mdx': 'c39d29deffb48d5978b419fab5a269644ff2bf6d7643f9add886f58f6cac549c',
  'en/api.mdx': '8e8b1dbf7a56a0725ea728420aa2403bba8039c5cfa5d44e61e7a930930d4a7f',
  'en/connect-your-number.mdx': 'dc41046d439ec409e2f6eba83c8b483d0fe41247db540fa10db408184481a1d8',
  'en/overview.mdx': 'fbaa765f2c8ed45ba054b1e4331d582c1e0511baeb38fd51b20a94c4cadbe5fb',
  'en/webhooks.mdx': '98ba0a3ba3d65917f3303746117639b1363705979226380d4da1ca63b682c8b3',
};
const tokens = (t: string) => t.match(/[\p{L}\p{N}]+/gu) ?? [];
const noTargets = (t: string) => t.replace(/\]\([^)]*\)/g, ']');
const body = (t: string) => t.replace(/^---\n[\s\S]*?\n---\n/, '').replace(/^\s*# .*\n/, '');
// the importer labels an empty table header cell, which adds exactly one word per such table
const HEAD_LABEL = /^\| (Option|الخيار) \|/m;

describe('Ebda WhatsApp docs equal their vendored source', () => {
  it('every vendored file is exactly the pinned version, and none is unpinned', () => {
    const found: string[] = [];
    for (const lang of ['ar', 'en'])
      for (const f of readdirSync(path.join(DOCS, 'wa-source', lang))) found.push(`${lang}/${f}`);
    expect(found.sort()).toEqual(Object.keys(PINNED_SHA256).sort());
    for (const [name, sha] of Object.entries(PINNED_SHA256))
      expect(
        createHash('sha256')
          .update(readFileSync(path.join(DOCS, 'wa-source', name)))
          .digest('hex'),
        name
      ).toBe(sha);
  });

  for (const name of Object.keys(PINNED_SHA256)) {
    it(`${name}: the published page has the source's words`, () => {
      const [lang, file] = name.split('/');
      const src = readFileSync(path.join(DOCS, 'wa-source', name), 'utf8');
      const out = readFileSync(path.join(DOCS, 'content', 'whatsapp', lang, file), 'utf8');
      const published = tokens(noTargets(body(out)));
      const want = tokens(noTargets(body(src)));
      const label = HEAD_LABEL.exec(out) && !HEAD_LABEL.test(src) ? 1 : 0;
      expect(published.length - label).toBe(want.length);
      expect(
        label
          ? published.filter((_, i) => i !== published.indexOf(HEAD_LABEL.exec(out)![1]))
          : published
      ).toEqual(want);
      expect(out).not.toMatch(/^# /m);
    });
  }

  it('negative control: a dropped word is detected', () => {
    const src = readFileSync(path.join(DOCS, 'wa-source', 'en', 'api.mdx'), 'utf8');
    expect(tokens(body(src).replace('Authentication', ''))).not.toEqual(tokens(body(src)));
  });
});
