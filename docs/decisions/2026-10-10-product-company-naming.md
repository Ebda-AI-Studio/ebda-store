# Product and company naming

Ahmad approved folders, repository and app branding on 2026-10-10.

Ruling NAMING-1 — Product = Ebda Store (ابدأ ستور); company = Ebda AI Studio (ابدأ ستوديو). Existing expanded legal operator names and domains/resource IDs remain. Evidence: approved scope, central BRAND.product/company contracts and unchanged deployment bindings. Cost if wrong: technical diagnostics may retain legacy service identifiers.

Ruling NAMING-MFA-2 — New MFA enrollments use Ebda Store as issuer; existing enrollments remain untouched. Evidence: verifyCode validates the stored secret and token, independently of issuer metadata. Cost if wrong: old authenticator entries keep the shorter Ebda label.

Ruling NAMING-FOOTER-1 — Footers select explicit localized company fields instead of interpolating the company object. Evidence: seven object interpolation paths found in docs/help/status; rendered-shell tests cover visible company identity. Cost if wrong: operator attribution could display incorrectly in one locale.

Ruling NAMING-GRAPH-1 — Commit the AST graph/report update; retain existing HTML because graphify's size guard skips generating the enlarged graph. Evidence: update generated 35,726 nodes and 65,330 edges. Cost if wrong: the optional interactive HTML remains older than the report and JSON.

Verification: affected brand/render/MFA/manifest tests (81), monorepo typecheck, lint and all affected app builds pass. Foundation resolver tests: 18 pass. All 23 worktree registrations, branches and dirty statuses survived the folder move. Repo remains private under Whisky-11 with main as default branch. Live rollout is recorded in handoff.md after deployment.

Ruling NAMING-AR-2 — Company Arabic name is ابدأ ستوديو للذكاء الاصطناعي everywhere; marketing uses Ebda AI Studio, including page titles and site metadata. Evidence: Ahmad explicitly corrected marketing naming and requested AI in Arabic everywhere on 2026-10-10. Product remains Ebda Store / ابدأ ستور. Cost if wrong: the longer Arabic name requires more header space, so verify mobile layout.

Ruling NAMING-SEO-1 — Every marketing page title, Open Graph/Twitter title and WebSite identity carries the localized company name. Evidence: Ahmad explicitly requested Google search titles and browser tabs. Google chooses and refreshes its displayed result independently after crawling. Cost if wrong: search may retain or rewrite its displayed title despite correct source metadata.

Ruling NAMING-EMAIL-1 — Platform emails display the full localized product name beside their abbreviated mark, and use localized footer attribution. Merchant logos remain merchant-owned. Company review/support wording uses the full company name. Evidence: the all-email sweep found English-only platform names and attribution plus abbreviated review-team copy; Ahmad requested all emails checked. Cost if wrong: the platform email header is taller; the existing email client layout gate covers rendering structure.

Ruling NAMING-CI-1 — Both unit jobs install Chromium plus its system dependencies before running browser-backed unit tests. Evidence: CI job114248550487 failed only analytics-bar-charts-render.test.tsx because libatk-1.0.so.0 was absent; the same test passes locally. This repairs the existing gate rather than skipping a test. Cost if wrong: CI spends extra setup time and requires the runner's normal package-install permissions.

Ruling NAMING-SWEEP-1 — Remaining abbreviated strings are dated records, code comments, internal translation lookup keys, existing service/alert identifiers, and the approved abbreviated mark; current visible text beside the mark carries the full product/company name. Evidence: AST string-literal sweep plus email/metadata consumer review and 8,376 passing unit tests. Merchant-authored names and existing authenticator entries are not rewritten. Cost if wrong: a diagnostic or historical record may still show the short name; rendered customer branding must be verified live after deploy.
