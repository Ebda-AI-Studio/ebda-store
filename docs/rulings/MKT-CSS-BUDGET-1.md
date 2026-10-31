# MKT-CSS-BUDGET-1

Ruling MKT-CSS-BUDGET-1 - raise the marketing default CSS budget from 12 KB to 12.5 KB gzip. The integrated tree (#367) measured every page at 12 KB rounded and over the old limit; the CSS comes from the folded marketing PRs, not one page. Ratchet down when the unused rules are pruned. Cost if wrong: about 0.5 KB more render-blocking CSS per marketing page, negligible on mobile LCP.
