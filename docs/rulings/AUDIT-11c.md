# AUDIT-11c

> Section: 2026-10-07 — AUDIT-P2P3 (FIX-011..015, branch `fix/audit-p2-p3`)

Ruling AUDIT-11c — ACCEPTED RESIDUAL: `extract-zip` (GHSA-jmr9-qjv8-65gv and GHSA-7pqw-9j4j-h8q3, <=2.0.1, symlink path traversal / arbitrary file write from a crafted archive) stays. Registry `latest` is 2.0.1 (last published 2023-03-04): no patched version. It is reached only through @puppeteer/browsers 2.x (lighthouse 12 / @lhci/cli 0.15, dev tooling) extracting the Chromium archive it downloads from Google's own CDN. The upstream fix is moving to @puppeteer/browsers 3.x (no extract-zip; needs lighthouse 13 / puppeteer-core 25), but `@lhci/cli` 0.15.1 still pins lighthouse 12.6.1 and `packages/site-kit` gates run Lighthouse in every site, so forcing it by override is an unmeasured gate change; not done here. Cost if wrong: a tampered Chromium archive from a compromised CDN writes outside its target directory on the machine that runs the Lighthouse gate.
