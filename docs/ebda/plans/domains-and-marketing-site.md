# Ebda — domains and marketing site (Ahmad, 2026-10-03)

Ebda is a **Whisky 11** product (org `whisky-11`, repo `whisky-11/ebda`, still empty). Domain: **ebda.app** (owned; .app is HSTS-preloaded, HTTPS only).

## Domain map

| Host                | Purpose                                                                                              | FWB equivalent today     |
| ------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------ |
| `ebda.app`          | Main marketing website (Shopify.com equivalent)                                                      | force-ai.co landing      |
| `admin.ebda.app`    | Dashboard / merchant application                                                                     | admin.force-ai.co        |
| `store.ebda.app`    | Default store infrastructure (path-based stores, e.g. `store.ebda.app/<slug>`) — "maybe", to confirm | store.force-ai.co/<slug> |
| `*.ebda.app`        | Individual merchant stores (`<slug>.ebda.app`); custom domains on top                                | per-store custom domains |
| `api.ebda.app`      | API                                                                                                  | api.force-ai.co          |
| `docs.ebda.app`     | API & developer documentation                                                                        | —                        |
| `whatsapp.ebda.app` | WhatsApp integration                                                                                 | WBS (separate product)   |
| `help.ebda.app`     | Help center                                                                                          | —                        |
| `status.ebda.app`   | System status                                                                                        | —                        |

Reserved subdomains (never assignable as a store slug): `app, store, api, docs, whatsapp, help, status, www, admin, orders, mail, cdn, assets, static`, plus anything else the platform takes later — enforce in slug validation from day one.

## Marketing site (`ebda.app`)

Superseded 2026-10-07 by Ruling R-EBDA-COPY-1 (`docs/RULINGS.md`): Ahmad asked for Egyptian colloquial Arabic and at least half the text. The original 12-section brief is kept below for history.

Top nav (now): logo · Features · How it works · Pricing · FAQ · `Log in` · **Start now** (→ signup on admin.ebda.app). Arabic: المميزات · إزاي بيشتغل · الأسعار · أسئلة · دخول · ابدأ دلوقتي.

Hero (now), per locale, over the Nile-at-night canvas (static inline poster first, canvas fades in):

> **ابدأ متجرك أونلاين في دقايق.** / **Open your online store in minutes.**

Sections (now, R-EBDA-COPY-5), in order (`SECTION_ORDER` in `apps/marketing/src/lib/site.ts`): Story (pinned scroll: the real Lamma storefront scrolls inside a phone, flips through the other templates, receives an order) · Templates (real captures of the five families on laptop, tablet and phone, live switcher; R-EBDA-COPY-8) · Features · Payments and shipping (provider logos) · Pricing (cards + full comparison table from the shared plan catalogue) · FAQ (max 8) · Closing call to action. Footer: contact (hello@, security@) and "Ebda by Whisky 11" linked to whisky11.com.

Original brief (2026-10-03, superseded):

- Top nav: EBDA · Features · Solutions · Pricing · Resources · Log in · Start selling.
- Hero: "ابدأ بيع أونلاين." / "Your business, your store, everything in one place."
- Sections: Create your store, How EBDA works, Store builder, Products & inventory, Orders, Payments, WhatsApp integration, Analytics, Pricing, Customer stories, FAQ, Login.

## Decisions (Ahmad, 2026-10-03, later)

- **Self-serve like Shopify, NOT managed like FWB**: merchants sign up, build and run their store alone; no onboarding by us.
- **Payments: every Egyptian provider** (Paymob, Kashier, Fawry, Valu/BNPL, Meeza, wallets, COD, and the rest available) behind a pluggable provider layer, plus **InstaPay** as a method with ONE manual step (merchant confirms the transfer).
- **Shipping: every available Egyptian carrier** — Bosta, Aramex, and the rest (e.g. J&T, Mylerz, R2S, Sprint, Egypt Post…) behind a pluggable carrier layer (rates, label, tracking webhooks).
- **Language: Arabic-first (RTL default) + English**, like FWB.
- **Pricing/packaging: not decided** — needs research on what to bundle per plan.
- **status.ebda.app: build it** (small, on infra independent of what it monitors).
- **whatsapp.ebda.app: WBS** — fix its backlog, rebrand it for Ebda; Ahmad will create a new Facebook account with the same permissions later. Parked for now.
- **Backend on Cloudflare** (port from Express/Railway), as already planned.
- **Colours + animations stay as decided** (night/Antique Gold, Nile-at-night login).
- **Hosting:** `store.ebda.app` dropped as a separate idea — every store gets `<slug>.ebda.app` free; merchants can attach a custom domain on top (see explanation in session 2026-10-03).
- Mechanical work runs on Sonnet; Opus only for design/security/ambiguous money.

## Questions answered above (kept for history)

- `store.ebda.app`: path-based default stores, or only `<slug>.ebda.app`?
- Language: Arabic-first (RTL default) with English toggle, like FWB storefronts?
- Pricing shown on the site: EGP 0 / 1,500 / 3,500 per month, 15,000 per year — my reading of "at least one fifty", not yet confirmed.
- `status.ebda.app`: hosted status page (e.g. a status provider) or built in?
- `whatsapp.ebda.app`: Ebda's own WhatsApp module, or WBS rebranded?

Brand: night #0A0B0C, Antique Gold #B08D57, lift #CBA873. Nile-at-night animation on the login page (source: `ebda-brief-v2.html`).
