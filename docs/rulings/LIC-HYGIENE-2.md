# LIC-HYGIENE-2

> Section: 2026-11-11 licensing-metadata hygiene (branch `chore/licensing-hygiene`)

**Ruling LIC-HYGIENE-2 - none of the 71 case-less files in test folders is dead; nothing is deleted.**
Of 71 files under test dirs with no `it(`/`test(`/`describe(`, every one is imported or referenced by another
non-doc file (helpers, stubs, fixtures, contract runners), and the 5 `*.test.ts` entry files
(`payment-provider-contract`, `shipping-contract-{aramex,bosta,mylerz,shipblu}`) call a shared contract runner that
registers the cases. Cost if wrong: a helper loaded only by a computed path string stays as clutter; harmless.
