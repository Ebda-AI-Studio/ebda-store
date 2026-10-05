# Ebda merchant UI — verification, 5 October 2026

Baseline: `origin/main` at `89461087`; UI branch: `codex/ebda-ui-ux`.

## Delivered

- Ebda antique gold/charcoal tokens, Geist and loaded IBM Plex Arabic font; dark-first default with saved light preference retained.
- Shared signup/verification/onboarding shell: wordmark, language control, setup guidance, working skip target, legal/support links.
- Compact template layout miniatures, mobile progress label, retry after onboarding state failure, manual InstaPay explanation.
- Dashboard guide actions wrap on mobile; server-owned completion remains unchanged.
- Signup requires a valid Egyptian mobile in the client, includes the HTML required attribute, localized empty-number error and request field.
- Cloudflare config generation derives routes from the built `BRAND` module. Admin/orders receive specific routes; inherited Kuwait merchant routes are removed from the storefront fallback config. Worker names and cache bindings are retained.

## Evidence

- 131 tests passed across 9 targeted files (signup, validation, onboarding API request bodies, setup guide, branding, contrast, generated CF routes).
- Admin TypeScript check exited 0.
- Final Cloudflare/OpenNext build succeeded: `.open-next/worker.js` generated and instrumentation restored.
- Wrangler dry run succeeded: 226 asset files; ASSETS binding; no deploy.
- Local workerd `/signup` and `/logo.svg`: HTTP 200. Browser rendered signup and switched Arabic/English on the built Worker.
- Browser mocked merchant journey: template PUT `{template:"elegant"}`; product POST for 250 EGP submitted `price:25000`, active status and inventory 10; payment PUT `{cod:true}`; launch summary rendered without publishing.
- Arabic mobile onboarding and real dashboard guide tested at 375×812: document scroll width 369, within viewport. Guide width 337. Manual payment completion invokes the existing setup-guide item endpoint.
- Screenshots inspected for signup, template selection and mobile guide. Local Worker preview at http://localhost:8788/signup.

## Limits / backend handoff

The merchant signup API schema (`apps/api/src/services/merchant-signup.service.ts`, `merchantSignupSchema.phone`) still accepts an omitted phone. Claude owns backend enforcement; client validation is not a server guarantee. No API behavior or DB schema was changed.

Authenticated journey used intercepted test API responses. Finance/stock/segments/entitlement APIs were explicitly unavailable in the fixture; socket timeouts are expected without a running backend. No real merchant creation, email delivery, upload, gateway settlement, real order, publish, live Cloudflare routing or production binding state was exercised. Storefront merchant themes/colors were preserved; illustrations are not real storefront screenshots. Only the touched admin bundle was rebuilt; web/orders route generation was tested in isolated fixture directories, not deployed.

Ruling UI-5 — Correct CF route generation under Ahmad's explicit Cloudflare steering: observed generated FWB hostnames differed from committed Ebda configs. Preserve existing Worker resource identities and bindings. Cost if wrong: an eventual deploy could route to an unintended host; review the generated routes before deployment.

Ruling UI-6 — Backend phone enforcement remains with Claude under explicit backend ownership. Exact schema location is recorded rather than implying client validation protects the API. Cost if wrong: direct API signup can still omit phone until that change lands.

Ruling UI-7 — The inherited graph was rebuilt with AST-only `graphify update .` (no semantic/API extraction); its report identifies the corpus refresh. Include generated graph changes with this batch per owner policy. Cost if wrong: inherited graph metadata can contain references outside this UI scope; source code remains the authority.

## Blast-radius

Swept `phoneRequired`, signup phone labels/validation, `admin-theme`, brand font/token names, public skip target, onboarding/template/payment text, setup-guide progress and Cloudflare generated hostnames across apps, packages, tests, scripts, CI and docs; compared FWB source read-only. Found and fixed inherited admin palette and generated FWB/Kuwait routes. Backend optional phone remains explicitly assigned to Claude. No production/sibling FWB changes.
