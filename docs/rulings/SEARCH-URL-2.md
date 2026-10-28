# SEARCH-URL-2

> Section: Launch blockers 31 and 32 (privacy): the search term and the ad pixels

- Ruling SEARCH-URL-2 (extends SEARCH-URL-1) - the WhatsApp bridge `GET /wa-bridge/products/search` reads the shopper's text from `X-Search-Query` too (answer `private, no-store`); `?q=` stays accepted for one release, DEPRECATED, so the bridge client (WBS, not in this repo) keeps working; remove it once the bridge sends the header. The site-kit search gate (`packages/site-kit/src/gates/search.mjs`) is a build-time smoke test that loads a locally built static site on 127.0.0.1 with fixed test queries: no shopper text and no Cloudflare log, so it is unchanged. Evidence: `tests/unit/wa-bridge-search-header.test.ts`. Cost if wrong: until the bridge ships the header its searches still sit in Workers Logs.
