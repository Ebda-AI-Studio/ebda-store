# TPL-INTERACT-1

> Section: 2026-10-22 — Phase B4 Lamma (B4-\*)

Ruling TPL-INTERACT-1 — the #looks phones stay interactive mini-stores (built-in markup + `mountPhones`: scroll, category filters, product, cart) for all five templates; real captures do not replace them. Evidence: the real-capture swap (#112, #121) made the phones static images, which broke the section's own promise ("scroll inside any phone and tap the filters"); Playwright now asserts every phone scrolls and a filter changes its grid, ar + en, all five. A live iframe of the demo store was rejected: it needs the storefront's `frame-ancestors` and the marketing CSP opened, and puts a consent banner and the demo bar inside every phone. The real stores are one tap away (one link per look). Cost if wrong: the mini-stores drift from the real looks and Ahmad still wants real pixels in the phones; the fix is a click-to-load frame behind a CSP change on demo hosts only.
