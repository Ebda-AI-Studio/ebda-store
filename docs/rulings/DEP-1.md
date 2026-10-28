# DEP-1

> Section: Backlog batch g-ci-scripts-other (2026-10-01)

**Ruling DEP-1 — next-intl 4.14.2 and its four new transitive packages stay (issue 1631); provenance
recorded here, not assumed.** The bump (#1629) added `@eloqnt/config`, `@eloqnt/format-json`,
`@eloqnt/format-po` (all 0.1.0, first published 2026-08-26) and `po-parser@2.2.0` to the production
tree. Checked 2026-10-01 (`npm view`): all four are published by the SAME sole maintainer as
next-intl itself (`amann <jan@amann.me>`); `po-parser` carries an SLSA provenance attestation and
links `github.com/amannn/po-parser`, the `@eloqnt/*` packages carry neither; none has an install
script (`hasInstallScript` absent in package-lock.json); all MIT. They are imported only by
next-intl's `extractor/` module (message extraction), which `apps/admin/next.config.js` does not
enable — `createNextIntlPlugin('./src/i18n/request.ts')` only — so they are shipped-but-unexecuted
by the admin build. Holding next-intl at 4.13.3 would re-open the advisories #1629 cleared.
Cost if wrong: a compromise of the next-intl author's npm account could ship through any of the
five packages; the `@eloqnt/*` three have no attestation to detect a registry-side substitution.
