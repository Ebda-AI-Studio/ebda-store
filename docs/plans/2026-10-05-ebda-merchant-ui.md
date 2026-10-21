# Ebda merchant UI implementation plan

**Goal:** Adapt the delivered Ebda Store interface to Ebda branding and make the self-service setup path understandable in Arabic and English.
**Architecture:** Retain the fork's existing components, server state and routes. Change presentation, translations and accessibility only; retain merchant storefront palette configuration.
**Tech stack:** Next.js 16, React 18, Tailwind 3, next-intl, existing @ebda/ui.
**Spec:** Owner request; approved `plan:docs/brand/ebda-brief-v2.html`; `packages/shared/src/brand/index.ts`.

## Constraints

- Ebda Store unchanged. Ebda isolated branch based on origin/main 89461087.
- No backend, payments, pricing, entitlements, migrations or production deployment.
- No free-plan/automated InstaPay/WhatsApp bot/full migration claims.
- Logical spacing; Arabic/RTL and English; compact transactional sizing.

## Review focus

- 375px Arabic setup labels must wrap without horizontal overflow.
- Gold button text and links must pass WCAG contrast in both themes.
- Server failures must retain inputs and expose existing errors.
- Template selections and product requests must preserve their API bodies.
- Keyboard users must reach language selection, template choices and form controls.

## Tasks

- [x] Rebrand admin CSS tokens and font wiring from Ebda authority; retain light theme and use approved charcoal in dark theme. Verify contrast regression suite.
- [x] Redesign shared public shell with wordmark, language switcher, setup overview, legal links and skip target. Verify signup validation and bilingual mobile layout.
- [x] Replace gradient-only template swatches with structured storefront miniatures; improve step status semantics, loading/retry and payment explanation. Verify existing onboarding contract tests and browser mocked journey.
- [x] Improve dashboard setup guide visual hierarchy and mobile actions without altering completion rules. Verify setup-guide tests and browser preview.
- [x] Run admin typecheck/build, browser evidence, consolidated identifier sweep; update handoff, commit specific files, push Ebda UI branch and create PR.

## Rulings

Ruling UI-1 — Implement directly in this session under explicit owner authorization. No additional plan approval gate. Cost if wrong: reviewable UI branch needs revision before merge.
Ruling UI-2 — Leave merchant storefront color configuration unchanged; miniature previews explain the delivered five templates. Store branding belongs to the merchant. Cost if wrong: merchant storefront may need a separate requested design pass.
Ruling UI-3 — Avoid pricing/trial copy while runtime seeds differ from approved pricing document. Cost if wrong: signup needs pricing context once backend prices are reconciled.

Ruling UI-4 — Dark-first follows the approved brief; saved light preference remains effective. Both initial HTML theme script and dashboard sync use the same default. Cost if wrong: users without a saved preference initially see dark mode.

Cloudflare steering: add scripts/cf-routes.cjs + generated-route regression tests; preserve Worker names/bindings. See UI-5 ruling in verification report.
