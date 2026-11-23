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
    '8b2a8d892528180a45aa259ea5352805be234f1b272bcac766dda8d1f5eca50b',
  'ar/02-connect-your-own-number.md':
    '54c2184ccec50bd3c2afc7980706ce667868b3e3f8cbec6e4aa74b80c2d56abb',
  'ar/03-use-the-shared-number.md':
    '5127580ca0150ef29930dfeb3099211fde1a3acfdc4a3ac11f6b17effdcf88b2',
  'ar/04-templates-and-the-24-hour-window.md':
    'd68d950a95de56c951a4a312b94f714646ab5a2447238133c018bb57badae0cf',
  'ar/05-cod-confirmations.md': '6f41ab63cfd3278c2f356dd56fe56ae7a76482aa3620546258e36f8282641dec',
  'ar/06-instapay-orders-in-whatsapp.md':
    '0af88aafe37a7c02213d426e964642188ee96ba1e9f5928d59216074376c568c',
  'ar/07-ai-agent.md': 'f5bd979b569e19a7c2440dab343fbc68c584059667a99cc348d7b39570f61be8',
  'ar/08-campaigns-and-opt-out.md':
    '7f9e117c3649335cf68d23258d474c82982345071b2dc7118b60e850623a545b',
  'ar/09-wallet-top-ups-and-refunds.md':
    'b9795ac9934070563c264da687cab52eaf92509c8c31c741887960e504146fb3',
  'ar/10-meta-fees-explained.md':
    '36d9b375852ce894e95f7f6f373b1c36b6e204da144e2b6ffcddbe4dce73826f',
  'ar/11-service-menu-hours-and-location.md':
    '778b6d30d6cdc26f9649aa5f3c45038c239070910e66b3c9b45ca50ee283c4c6',
  'ar/12-delete-your-workspace.md':
    '4efe2199028d4c9a6669a10a4582673f28a6cc54012a4eea79f7d9c117906937',
  'ar/13-your-customers-data.md':
    '76d0b4fe85a964ea7c8d614108ac143717078ed5dd9a6e90385141bad7866c99',
  'ar/14-team-members-and-seats.md':
    'a4aa8d62aea37440a4c2a0269da25765121abb48e136e2863f49608d2fb88449',
  'ar/15-your-products-on-whatsapp.md':
    '6d92b917e75421bf02ddbc3a966eed284e1a1ce7faca2294776e3301a34abf9e',
  'ar/16-write-and-submit-a-template.md':
    '98d687763d3117a737ce6b5ae897012b13e0a12906804f3a59a79782e5b80d6a',
  'ar/17-template-review-and-rejections.md':
    '58499968fcebd5e3d1212437dd0cb063cd9b746da0be960c2f6388acf9ae30c2',
  'ar/18-sign-in-language-and-sign-out.md':
    '1a8260083eafb3cb565a36c299f1e0f27e06180435582befe1306d57191956e9',
  'ar/19-find-your-conversations.md':
    'b4bc7e98759149f99d9e92b2e8961f29310e7c8c5cd603c9123062ada868e4fa',
  'ar/20-read-a-conversation-and-live-updates.md':
    'c7f6de0c006f50dd8d4fc914cb2a44e90bea045652f84ae0fe1558817645cbbf',
  'ar/21-send-files-in-chat.md': 'ce666420a770ac7ecb1d67bcce5c4819cb227f7678f0ca94aab47f3c7d3efe91',
  'ar/22-failed-messages-and-sending-limits.md':
    '52cce12b3d087fd4c8ffa4690158f7cd281a629b33d854f41d3f0150f97c981d',
  'ar/23-notes-tags-and-quick-replies.md':
    'c4b0c4250bccc8451f730eb979e72d80fa10237b551dbb5f5e229a4b01c38459',
  'ar/24-weekly-summary.md': 'e01b8141c0cdd862865b02ab36635da7ae23aa45ccc5a008c4969987dd46d243',
  'ar/25-alerts-and-notices.md': '53d1c16045eb777c299601286dc87e0a655af7fb717a38573163877010b5d3bb',
  'ar/26-verification-codes-on-whatsapp.md':
    '4b3a3e97a5bcbba2aadec6c61bac90baee7be59ec60298753c43efc146f7ee60',
  'ar/27-connect-your-systems.md':
    '0ae3e8a5eef5e5bc5a14eeee8e66fe2b23fb8a7400252bf7cd01710f7c5fa36b',
  'ar/28-terms-privacy-and-meta-data-deletion.md':
    'a662cddd5d11f51f6ab4ad1d010f9c9fa82d7746b1aa5abe91890b7e0a571931',
  'ar/29-all-ebda-chat-guides.md':
    '466b4b82e53a68a2986965e8ff09bde555d5313a67e8ed02a462681a485cc5d5',
  'en/01-verify-your-business-on-meta.md':
    'fee1d100d32e6a34012f8f6e1af1d36d2ec153cce8fbf40f651568b8e3c52509',
  'en/02-connect-your-own-number.md':
    '2172df5594d96e78e9c6d8a7e74976a3136cbb75dbce846c8da796025af0d8d9',
  'en/03-use-the-shared-number.md':
    '70cc33f5b911a62875b85ad290e7042eda595a6e8e5a6901c16dc9560c032876',
  'en/04-templates-and-the-24-hour-window.md':
    '492d692fd01c6b57d6be6f721202cc7ec9ff8c032f7a52718ceb81ef98d5dd75',
  'en/05-cod-confirmations.md': 'a7ac394a6c041d8b792900270923b4a59961d4c22cedd2649f06e6548b5f885f',
  'en/06-instapay-orders-in-whatsapp.md':
    'f25b38c8332fb78cd06dbbfdb00ae15d33f42ab393ba04c0dcbb7ef0fcbb6a95',
  'en/07-ai-agent.md': '0ed78059fec03e332af470457ede614b3515bd7e3e12600a7f599cc1888025b8',
  'en/08-campaigns-and-opt-out.md':
    '3c45c20d19d09d5ff4287ef22800ca5d07222ebb842e1ede5d494619f7767bcd',
  'en/09-wallet-top-ups-and-refunds.md':
    'bf5ef6232e52d6e1f129638619a8f596acf5d236a504f2cf2681af8a30577064',
  'en/10-meta-fees-explained.md':
    '70800e78c6eaefacf07b0a21472bf7f954f77733a93a86ea880c4467c6ea0437',
  'en/11-service-menu-hours-and-location.md':
    '09e04151908ae0007864719098a24e9eb198a846dd02df62f28d022637aea408',
  'en/12-delete-your-workspace.md':
    '7ac321e999f1e1418ba379ddc36a20e86c75049f612910732da93873cf4bf36c',
  'en/13-your-customers-data.md':
    'e3643cd1b68e12fe889ae0cc24761d697b87bbe8e001e1e20fcdbf8dafeb5b8a',
  'en/14-team-members-and-seats.md':
    '999c1f930471900ad9b3d8f3b1c3547cf8e62f18f474007ff0edfe950498a312',
  'en/15-your-products-on-whatsapp.md':
    '579528cf2381ccd6b377725a0ca168de9269defb54d4a2a97e5e96317780f691',
  'en/16-write-and-submit-a-template.md':
    '7c40acd2c1c383d7b70126501abdf04159982a9c77a1e9de9ee227386800b3ff',
  'en/17-template-review-and-rejections.md':
    'eb65d4bf24b09c7ab1384f8a77cf8a107da28e743c2f5fa0e77d23e7d8373adb',
  'en/18-sign-in-language-and-sign-out.md':
    '922b69dd1558ba6682d56b75dcc94fb5165464f1dd659e8972cdada8e31e1bd0',
  'en/19-find-your-conversations.md':
    '419bfb5fbfcbc78dbc89f66a0161114d2f1173d9454fec69fa9ebc2b1922630a',
  'en/20-read-a-conversation-and-live-updates.md':
    'e5b8a1a967a9f36a7668c77c207f970a99d10837e65f0db5d1efbfbf9bf74c9d',
  'en/21-send-files-in-chat.md': 'dad69dd329738d1613f6b06e99a84e2bd449b9b0cc508aa59768811f8bc1da88',
  'en/22-failed-messages-and-sending-limits.md':
    '0a5928c1ec089866b086a79ff8d409b845bc610884c93d6a73fe8ef3cf8a3e40',
  'en/23-notes-tags-and-quick-replies.md':
    '00a966def5d27f3c6b61884df0bb1931301121c16a55b2790e986893661724a6',
  'en/24-weekly-summary.md': '3aa049404700da2e6c6488f8dbac99be6c331f99b8558fefb9414b6cefb69c71',
  'en/25-alerts-and-notices.md': 'ab80d29d5395dd92b42827897eb5047447baebf664a126840d9c89bb29d289d6',
  'en/26-verification-codes-on-whatsapp.md':
    '212a13ddc9a919cb935a2bf608745a45bc4c360372161715c771e04701a216b9',
  'en/27-connect-your-systems.md':
    'a3fbab228dd9245340910d5a1a85d2e2bd6cf311a0ebdea530a02ce65e46004c',
  'en/28-terms-privacy-and-meta-data-deletion.md':
    '4308de0bed6e58470cce48be6a3044a544f9944e61c47d45be0ae823bcc721c8',
  'en/29-all-ebda-chat-guides.md':
    '014995eb870bbcc94704706bda308ff388511ee4d3451981fb8d2d1ae8c18db5',
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
        const source = src.replace(/^---\n[\s\S]*?\n---\n/, '').replace(/^\s*# .*\n/, '');
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

  it('every vendored guide is published in both locales (none left behind)', () => {
    for (const lang of ['ar', 'en']) {
      const slugs = readdirSync(path.join(HELP, 'wa-source', lang)).map(f =>
        f.slice(3).replace(/\.md$/, '')
      );
      expect(slugs.length).toBeGreaterThan(0);
      expect(
        readdirSync(path.join(HELP, 'content', lang, 'whatsapp'))
          .map(f => f.replace(/\.mdx$/, ''))
          .sort()
      ).toEqual(slugs.sort());
    }
  });
});
