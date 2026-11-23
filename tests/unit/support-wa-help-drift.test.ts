import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The Ebda Chat help guides on help.ebda.app/whatsapp/ equal their source (ebda-whatsapp docs/help/{ar,en}/NN-slug.md,
 * vendored verbatim in apps/help/wa-source/ by `node apps/help/scripts/import-wa-help.mjs <docs/help>`). PINNED_SHA256 pins
 * each vendored file to the version the WhatsApp session published: when they ship new text, re-import and update the
 * hashes together. The word comparison fails if a published page differs from its source (link targets aside).
 */
const HELP = path.resolve(__dirname, '../../apps/help');
const PINNED_SHA256: Record<string, string> = {
  'ar/01-verify-your-business-on-meta.md':
    '802f25961b54fbd5d0714187990becfd0fe5093750fea6c43c4e089fa62cd566',
  'ar/02-connect-your-own-number.md':
    '7c78d73479ce44dbd2eeb9cd96fb4b6c67ec150b7a4b04f4ffbf94dd892fe2df',
  'ar/03-use-the-shared-number.md':
    '840979f2ea3bcfaf4000f8e5510196d56576f7eeded449294668910bcdddf33a',
  'ar/04-templates-and-the-24-hour-window.md':
    '65bea01b18064a8fbfcc251bebde5f21a0cc666e0fc2be9655069d57fa487995',
  'ar/05-cod-confirmations.md': '3e1d726629b3cdc258f99fbcf8efcb07224b1f174b14cf1e90b22649f689742e',
  'ar/06-instapay-orders-in-whatsapp.md':
    'd02829291f3503e08bbc6d89717aa72fd77cd605b8be451adbf426f847228a97',
  'ar/07-ai-agent.md': 'c65b53c5f268272c1b8e4f38e8bafca7f3e5c867e6713432162e0835ec966013',
  'ar/08-campaigns-and-opt-out.md':
    '2b059c59937e0b71b09bdc88198224829e38787cb175fac36a7582a196d4b6f0',
  'ar/09-wallet-top-ups-and-refunds.md':
    '2261cb53a55ea63f7775d9d52c7343332d744c858cca5b96da920a5ecf9c6bab',
  'ar/10-meta-fees-explained.md':
    'a91a05bbb7ddbdc236b6b4f5c0557d5e8f763a43fae09c450498b90750a0659f',
  'ar/11-service-menu-hours-and-location.md':
    '37c92f3718b22c245bd20b0a7a5151bbabfddf01d51b2da561d8ba2a7a3cb0ac',
  'ar/12-delete-your-workspace.md':
    '762abb80d07114750ff5dbdadf4a48e71b9e32c26f417be1c6c7123a053f142d',
  'ar/13-your-customers-data.md':
    '70c99e0bc2e321ad79bd6a6001ea2f921c0a2c48432b977f5f98badbd24a2c44',
  'ar/14-team-members-and-seats.md':
    '6a22ae8f86847eb1f0d54cf89df486a2aae1509eef2b02d0a8cd1cf6773811b3',
  'en/01-verify-your-business-on-meta.md':
    '3de91aea62cd457aa08d7bed246781d1d7908c8208b643dbfa3a30eff3b5e8b2',
  'en/02-connect-your-own-number.md':
    '34ea9294215fe8b0be66527d0203dd743c38176276c61c64cd90ba8e0dcc03b4',
  'en/03-use-the-shared-number.md':
    'f8241dac63f9dc29d09219a15cbc677b19af45373630fe99c65d24828ddcef72',
  'en/04-templates-and-the-24-hour-window.md':
    '34cd5123b5806cc76643269cc99c441ad226a6a581f52225ff7fd461b0a4c8ef',
  'en/05-cod-confirmations.md': '41d46d3aaa7d10ec327f4ba8a69d898bb4d0a32b08143db62751463d17802b4d',
  'en/06-instapay-orders-in-whatsapp.md':
    '5c41633f1f1adf3fc1159e85bed7cc9cc8f27144f3ff42563f2493528e1e715a',
  'en/07-ai-agent.md': '4670c20b6232664cf71d1c8dc91305786d2806019bf684841a770f2b49a5b055',
  'en/08-campaigns-and-opt-out.md':
    '380b45e446e026e57e4c3d03f9ba1b5eff4c5b4a9d8bb0adb522434aef467f32',
  'en/09-wallet-top-ups-and-refunds.md':
    'f22ebefd8ee916b56677b0f9905f08a75ae275e743caf705c2f78af77ffd8541',
  'en/10-meta-fees-explained.md':
    '2f79f146fa6fc55f8c137d8a5af96dfcec0e50612f16062b15c69246aadd7693',
  'en/11-service-menu-hours-and-location.md':
    'c6e9ca322f45a98148ad2d2ab47ed7aefbdb4e7ea801a39e8db5e6b4cf30847a',
  'en/12-delete-your-workspace.md':
    '1f2ae43438a4cf7b533e50e3c72bd7a6c16faf2dea47ea5bbab8fe540b8598c9',
  'en/13-your-customers-data.md':
    'd1e2b534f7016ffec835b5ef4dc1925fe2f99fc401f9061896f815b86b060bd7',
  'en/14-team-members-and-seats.md':
    'bf6360df3c3bf00f2bcad5ad98ee69fd7bb18dfe2aade7cfed6170874d76d131',
};
const tokens = (t: string) => t.match(/[\p{L}\p{N}]+/gu) ?? [];
const noTargets = (t: string) => t.replace(/\]\([^)]*\)/g, ']');

describe('Ebda Chat help guides equal their vendored source', () => {
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

  it('every vendored guide is published in both locales (14 guides, none left behind)', () => {
    for (const lang of ['ar', 'en']) {
      const slugs = readdirSync(path.join(HELP, 'wa-source', lang)).map(f =>
        f.slice(3).replace(/\.md$/, '')
      );
      expect(slugs.length).toBe(14);
      expect(
        readdirSync(path.join(HELP, 'content', lang, 'whatsapp'))
          .map(f => f.replace(/\.mdx$/, ''))
          .sort()
      ).toEqual(slugs.sort());
    }
  });
});
