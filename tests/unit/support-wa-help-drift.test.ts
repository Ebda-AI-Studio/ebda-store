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
    '56ff1658d07af189e685b07b7da9ffd057a55ee7a7013c2c9179c6b13121cb4e',
  'ar/03-use-the-shared-number.md':
    '53c7c97019c0c326ab828a26bd9d3ae0795dfb61087241afd3e99bd36cb027ea',
  'ar/04-templates-and-the-24-hour-window.md':
    '0ca3f09794a10b4c84cac4187ad4caff8b478903f4d291ce676b61cd434c78e1',
  'ar/05-cod-confirmations.md': '91f62e3356718ef87dcc7d6461abf8aceab53f8cfa640762ae7685bf635711ef',
  'ar/06-instapay-orders-in-whatsapp.md':
    'a2d574dcad19da541df2e4029cca86aac2c0eedaf4f1395464ab8fef9338768b',
  'ar/07-ai-agent.md': 'c65b53c5f268272c1b8e4f38e8bafca7f3e5c867e6713432162e0835ec966013',
  'ar/08-campaigns-and-opt-out.md':
    'b9a1a485298695b57be76cf7511d6b1501931f15e49302813671b86017e92426',
  'ar/09-wallet-top-ups-and-refunds.md':
    'e8b979651a8a26164ba466ab1e6cfcafacc97bbe72557e549728fea21b2a0e3b',
  'ar/10-meta-fees-explained.md':
    'a91a05bbb7ddbdc236b6b4f5c0557d5e8f763a43fae09c450498b90750a0659f',
  'ar/11-service-menu-hours-and-location.md':
    'bdbd2763b248c1c7159f85b0924dde47d209894e47039bf04982fb967ab925f4',
  'en/01-verify-your-business-on-meta.md':
    '3de91aea62cd457aa08d7bed246781d1d7908c8208b643dbfa3a30eff3b5e8b2',
  'en/02-connect-your-own-number.md':
    '6ed621a4502388b4d98c152e469205c10b5f6cb9954250816b9c1305006a9e9d',
  'en/03-use-the-shared-number.md':
    'f92ea39735dffcd6b5069d066b25baf0c0b832f4b40905b82f0eeff8a742dc7f',
  'en/04-templates-and-the-24-hour-window.md':
    '77ccada792ca49c7c6d3c34dd7d1641e6578d9f878b9d36655bed6bacbf84b38',
  'en/05-cod-confirmations.md': 'de265900d41f2ad2ac9797cd547dd8db723e49908f7a9557fb3d44c63d277e07',
  'en/06-instapay-orders-in-whatsapp.md':
    'fcc636f8f4b82394d81924652351bdb333411a229e22d8bc0c8091b1be050452',
  'en/07-ai-agent.md': '4670c20b6232664cf71d1c8dc91305786d2806019bf684841a770f2b49a5b055',
  'en/08-campaigns-and-opt-out.md':
    'a17efb005fd6feacb792967ddca19a9c80630d99f665f6381dc1096d13c0c389',
  'en/09-wallet-top-ups-and-refunds.md':
    '5e62915108cd006d12c1689e5ae710543bea0dd99622bd14803abfeec4066d9c',
  'en/10-meta-fees-explained.md':
    '2f79f146fa6fc55f8c137d8a5af96dfcec0e50612f16062b15c69246aadd7693',
  'en/11-service-menu-hours-and-location.md':
    'c6e9ca322f45a98148ad2d2ab47ed7aefbdb4e7ea801a39e8db5e6b4cf30847a',
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
});
