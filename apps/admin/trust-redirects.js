/**
 * QA-TRUST-1 (site trust standard): /legal, /privacy and /terms are real URLs on every Ebda site, and
 * /llms.txt answers. The admin (store.ebda.app) has no policy pages of its own, so it sends each to the
 * studio's pages on ebda.app in one 308 hop. The language is kept (/ar and bare go to the Arabic page, /en
 * to the English one). Next strips a trailing slash first, so only the slash-less source is listed. `llms.txt` is the studio's canonical file, so there is one source and no drift.
 * Required by next.config.js; pinned by tests/unit/trust-urls-redirect.test.ts.
 */
const PAGES = ['legal', 'privacy', 'terms'];

/** @returns {Array<{source: string, destination: string, permanent: true}>} */
function trustRedirects() {
  const out = [];
  for (const p of PAGES) {
    for (const [prefix, base] of [
      ['', `https://ebda.app/${p}/`],
      ['/ar', `https://ebda.app/${p}/`],
      ['/en', `https://ebda.app/en/${p}/`],
    ]) {
      out.push({ source: `${prefix}/${p}`, destination: base, permanent: true });
    }
  }
  out.push({ source: '/llms.txt', destination: 'https://ebda.app/llms.txt', permanent: true });
  return out;
}

module.exports = { trustRedirects };
