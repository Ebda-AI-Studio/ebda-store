# Contact form for Ebda AI Studio service enquiries (2026-11-03)

Ahmad approved. Branch `feat/contact-form` (from `feat/studio-nav-footer-sites`, PR #391). Ruling CONTACT-FORM-1.

Finish line: the form on `/contact` and `/en/contact` sends a validated enquiry to ahlan@ebda.app (Reply-To the visitor) plus a receipt to the visitor; a failed send never shows success and raises a P1 alert; nothing is stored; the touched tests, typechecks and the rulings/hexagram guards are green. Must not change: the other contact methods on the page, the sitemap/hreflang, the About CTA target, any other CSP.

Findings that shaped it

- Marketing is a static export (no server). A cross-origin `<form action=API>` works without JavaScript; the API 303s back to `/contact/#sent|#send-failed` (static `:target` panels).
- No Turnstile key/binding in the repo (only a mention in S4-1) -> honeypot + minimum fill time + the existing store-backed rate limiter (5/hour per IP, 5/hour per email). No new provider, no new env var.
- Email goes through `EmailService` -> `mail-transport` (Cloudflare Email Service `EMAIL` binding); sent directly and awaited, never through the retry queue, so success is only shown after the send resolved.
- Marketing CSP was `frame-ancestors 'none'` only; adding `form-action 'self' https://api.ebda.app` is all the form needs.

Steps (each with its check)

1. Shared contract `packages/shared/src/contact-enquiry.ts` (topics from BRAND.services, limits, phone/email normalisers) -> unit test.
2. API route `POST /public/contact/enquiry`, limiters, templates, `EmailService.sendContactEnquiry[Receipt]` -> route + limiter tests (validation, honeypot, fill time, escaped content, failure path, log hygiene, no-JS redirect).
3. Marketing `ContactForm` + `ContactPage` + `contact.css` + copy (ar/en) -> UI tests (render, errors + focus, success, failure, no-JS panels).
4. CSP `_headers` -> CSP test.
5. Docs: `docs/api/studio-enquiry.md`, ruling + index. No env var added (docs/ENVIRONMENT.md unchanged).
6. Guards: rulings index, hexagram, lastmod hash, email-template layout coverage, typecheck shared/api/marketing, eslint.

Deploy notes: nothing to set. The API Worker already has the `EMAIL` binding and the Telegram alert variables. Deploy the API (`cf-api-deploy.yml`, manual) BEFORE or with the marketing deploy, or the form posts to a 404.
