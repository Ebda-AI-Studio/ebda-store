import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The Ebda WhatsApp help guides on help.ebda.app/whatsapp/ equal their source (ebda-whatsapp docs/help/{ar,en}/NN-slug.md,
 * vendored verbatim in apps/help/wa-source/ by `node apps/help/scripts/import-wa-help.mjs <docs/help>`). PINNED_SHA256 pins
 * each vendored file to the version the WhatsApp session published: when they ship new text, re-import and update the
 * hashes together. The word comparison fails if a published page differs from its source (link targets aside).
 */
const HELP = path.resolve(__dirname, '../../apps/help');
const PINNED_SHA256: Record<string, string> = {
  'ar/01-verify-your-business-on-meta.md':
    '802f25961b54fbd5d0714187990becfd0fe5093750fea6c43c4e089fa62cd566',
  'ar/02-connect-your-own-number.md':
    'f3196178cc89558af0c0fa78c935bfc57fb29bb94d324b4cbd61ed1423f8cba8',
  'ar/03-use-the-shared-number.md':
    '621957716efc09ae1e10c9caafe98de8664601071a3f9132bc17c4844e939e9d',
  'ar/04-templates-and-the-24-hour-window.md':
    '0ca3f09794a10b4c84cac4187ad4caff8b478903f4d291ce676b61cd434c78e1',
  'ar/05-cod-confirmations.md': '91f62e3356718ef87dcc7d6461abf8aceab53f8cfa640762ae7685bf635711ef',
  'ar/06-instapay-orders-in-whatsapp.md':
    'a2d574dcad19da541df2e4029cca86aac2c0eedaf4f1395464ab8fef9338768b',
  'ar/07-ai-agent.md': 'c65b53c5f268272c1b8e4f38e8bafca7f3e5c867e6713432162e0835ec966013',
  'ar/08-campaigns-and-opt-out.md':
    '2b059c59937e0b71b09bdc88198224829e38787cb175fac36a7582a196d4b6f0',
  'ar/09-wallet-top-ups-and-refunds.md':
    '8af45b9a4f5c5965b03f06408e8f067cf2696b617cee09772bbf7141bff87f6d',
  'ar/10-meta-fees-explained.md':
    'a91a05bbb7ddbdc236b6b4f5c0557d5e8f763a43fae09c450498b90750a0659f',
  'ar/11-service-menu-hours-and-location.md':
    '37c92f3718b22c245bd20b0a7a5151bbabfddf01d51b2da561d8ba2a7a3cb0ac',
  'ar/12-delete-your-workspace.md':
    '8558653848df02992f0e31a892b5f1b8e1092a4ee4fa5d05e316f2c063778970',
  'ar/13-your-customers-data.md':
    '70c99e0bc2e321ad79bd6a6001ea2f921c0a2c48432b977f5f98badbd24a2c44',
  'en/01-verify-your-business-on-meta.md':
    '3de91aea62cd457aa08d7bed246781d1d7908c8208b643dbfa3a30eff3b5e8b2',
  'en/02-connect-your-own-number.md':
    '6601a5a1826546df50bd69c559bf9dcd739d85dd3bc50dff3908415d55eb19a2',
  'en/03-use-the-shared-number.md':
    'f8241dac63f9dc29d09219a15cbc677b19af45373630fe99c65d24828ddcef72',
  'en/04-templates-and-the-24-hour-window.md':
    '77ccada792ca49c7c6d3c34dd7d1641e6578d9f878b9d36655bed6bacbf84b38',
  'en/05-cod-confirmations.md': 'de265900d41f2ad2ac9797cd547dd8db723e49908f7a9557fb3d44c63d277e07',
  'en/06-instapay-orders-in-whatsapp.md':
    'fcc636f8f4b82394d81924652351bdb333411a229e22d8bc0c8091b1be050452',
  'en/07-ai-agent.md': '4670c20b6232664cf71d1c8dc91305786d2806019bf684841a770f2b49a5b055',
  'en/08-campaigns-and-opt-out.md':
    '380b45e446e026e57e4c3d03f9ba1b5eff4c5b4a9d8bb0adb522434aef467f32',
  'en/09-wallet-top-ups-and-refunds.md':
    '9ab15f3fa80da14c19c814d6fb870e5aad240a9624dd533ea6734d9f38532667',
  'en/10-meta-fees-explained.md':
    '2f79f146fa6fc55f8c137d8a5af96dfcec0e50612f16062b15c69246aadd7693',
  'en/11-service-menu-hours-and-location.md':
    'c6e9ca322f45a98148ad2d2ab47ed7aefbdb4e7ea801a39e8db5e6b4cf30847a',
  'en/12-delete-your-workspace.md':
    '827f1f33a5c58c64c0a0ff0f4e706314ae1c802534919da6c6cc026446c1571b',
  'en/13-your-customers-data.md':
    'd1e2b534f7016ffec835b5ef4dc1925fe2f99fc401f9061896f815b86b060bd7',
};
const tokens = (t: string) => t.match(/[\p{L}\p{N}]+/gu) ?? [];
const noTargets = (t: string) => t.replace(/\]\([^)]*\)/g, ']');

describe('Ebda WhatsApp help guides equal their vendored source', () => {
  it('every vendored file is exactly the pinned version, and none is unpinned', () => {
    const found: string[] = [];
    for (const lang of ['ar', 'en'])
      for (const f of readdirSync(path.join(HELP, 'wa-source', lang))) found.push(`${lang}/${f}`);
    expect(found.sort()).toEqual(Object.keys(PINNED_SHA256).sort());
    for (const [name, sha] of Object.entries(PINNED_SHA256))
      expect(
        createHash('sha256')
          .update(readFileSync(path.join(HELP, 'wa-source', name)))
          .digest('hex'),
        name
      ).toBe(sha);
  });

  for (const lang of ['ar', 'en'])
    for (const name of Object.keys(PINNED_SHA256).filter(n => n.startsWith(lang + '/'))) {
      it(`${name}: the published page has the source's words`, () => {
        const slug = name.slice(lang.length + 4).replace(/\.md$/, '');
        const src = readFileSync(path.join(HELP, 'wa-source', name), 'utf8');
        const mdx = readFileSync(
          path.join(HELP, 'content', lang, 'whatsapp', `${slug}.mdx`),
          'utf8'
        );
        const body = mdx.replace(/^---\n[\s\S]*?\n---\n/, '');
        const title =
          /^title:\s*'(.*)'\s*$/m.exec(mdx)?.[1] ?? /^title:\s*"(.*)"\s*$/m.exec(mdx)?.[1] ?? '';
        const clean = (s: string) => s.replace(/\*\*/g, '').replace(/`/g, '');
        const source = src.replace(/^# .*\n/, '');
        expect(tokens(noTargets(clean(body)))).toEqual(tokens(noTargets(clean(source))));
        expect(tokens(clean(src.match(/^# (.*)$/m)![1]))).toEqual(
          tokens(title.replace(/''/g, "'"))
        );
      });
    }

  it('negative control: a dropped word is detected', () => {
    const src = readFileSync(
      path.join(HELP, 'wa-source', 'en', '08-campaigns-and-opt-out.md'),
      'utf8'
    );
    expect(tokens(src.replace('opt-out', ''))).not.toEqual(tokens(src));
  });

  it('the service menu guide (11) is published in both locales', () => {
    for (const lang of ['ar', 'en'])
      expect(readdirSync(path.join(HELP, 'content', lang, 'whatsapp'))).toContain(
        'service-menu-hours-and-location.mdx'
      );
  });

  it('every vendored guide is published in both locales (13 guides, none left behind)', () => {
    for (const lang of ['ar', 'en']) {
      const slugs = readdirSync(path.join(HELP, 'wa-source', lang)).map(f =>
        f.slice(3).replace(/\.md$/, '')
      );
      expect(slugs.length).toBe(13);
      expect(
        readdirSync(path.join(HELP, 'content', lang, 'whatsapp'))
          .map(f => f.replace(/\.mdx$/, ''))
          .sort()
      ).toEqual(slugs.sort());
    }
  });
});
