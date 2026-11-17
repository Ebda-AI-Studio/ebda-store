# Ebda — domains and marketing site (Ahmad, 2026-10-03)

Ebda is a **Whisky 11** product (org `whisky-11`, repo `whisky-11/ebda`, still empty). Domain: **ebda.app** (owned; .app is HSTS-preloaded, HTTPS only).

## Domain map

| Host                | Purpose                                                                                                                | Ebda Store equivalent today |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `ebda.app`          | Main marketing website (Shopify.com equivalent)                                                                        | ebda.app landing            |
| `store.ebda.app`    | Ebda Store merchant app: sign-up, plan, payment, onboarding, dashboard (Ruling HOST-STORE-1; `admin.ebda.app` retired) | store.ebda.app              |
| `*.ebda.app`        | Individual merchant stores (`<slug>.ebda.app`); custom domains on top                                                  | per-store custom domains    |
| `api.ebda.app`      | API                                                                                                                    | api.ebda.app                |
| `docs.ebda.app`     | API & developer documentation                                                                                          | —                           |
| `whatsapp.ebda.app` | WhatsApp integration                                                                                                   | WBS (separate product)      |
| `help.ebda.app`     | Help center                                                                                                            | —                           |
| `status.ebda.app`   | System status                                                                                                          | —                           |

Reserved subdomains (never assignable as a store slug): `app, store, api, docs, whatsapp, help, status, www, admin, orders, mail, cdn, assets, static`, plus anything else the platform takes later — enforce in slug validation from day one.

## Marketing site (`ebda.app`)

Superseded 2026-10-07 by Ruling R-EBDA-COPY-1 (`docs/RULINGS.md`): Ahmad asked for Egyptian colloquial Arabic and at least half the text. The original 12-section brief is kept below for history.

Top nav (now): logo · Features · How it works · Pricing · FAQ · `Log in` · **Start now** (→ signup on store.ebda.app). Arabic: المميزات · إزاي بيشتغل · الأسعار · أسئلة · دخول · ابدأ دلوقتي.

Brand line (2026-10-07): «ابدأ — بابك لبدء مشروعك.» / "Ebda — Your doorway to business." (hero, meta, OG). Hero (then), per locale, over the Nile-at-night canvas (static inline poster first, canvas fades in):

> **ابدأ متجرك أونلاين في دقايق.** / **Open your online store in minutes.**

Superseded 2026-10-14 by `docs/plans/done/2026-10-14-marketing-levelup.md` (MKT-1..5): light canvas, one cycling looks phone as the hero, looks first, the story scroll kept with Dahab-look frames, no break-out/device frames/how band, product name in the header, WhatsApp contact. The paragraph below is the history before that.

Sections (then, R-EBDA-COPY-5/8/10/11), in order (`SECTION_ORDER` in `apps/marketing/src/lib/site.ts`): Story (pinned scroll: the real Dahab storefront scrolls inside a phone, then a stream of four notifications) · How it works (four numbered cards, a gold line draws each in) · Devices (one real store, Dahab, on laptop, tablet and phone; no switcher until the Phase 3 templates, R-EBDA-COPY-14) · Break-out (pinned: the Dahab ring leaves the phone while gold wipes up and giant outlined «ابدأ / متجرك / دلوقتي» drift) · Dahab (live three.js ring, drag + scroll, metal and stone swatches) · Features · Payments and shipping (provider marks) · The Ebda story («حكاية ابدأ», the open-door mark animates: the light comes up, the person steps through) · Pricing (cards + full comparison table from the shared plan catalogue) · FAQ · Closing call to action. Footer: contact (ahlan@, security@) and "Ebda by Whisky 11" linked to whisky11.com.

Original brief (2026-10-03, superseded):

- Top nav: EBDA · Features · Solutions · Pricing · Resources · Log in · Start selling.
- Hero: "ابدأ بيع أونلاين." / "Your business, your store, everything in one place."
- Sections: Create your store, How EBDA works, Store builder, Products & inventory, Orders, Payments, WhatsApp integration, Analytics, Pricing, Customer stories, FAQ, Login.

## Decisions (Ahmad, 2026-10-03, later)

- **Self-serve like Shopify, NOT managed like Ebda Store**: merchants sign up, build and run their store alone; no onboarding by us.
- **Payments: every Egyptian provider** (Paymob, Kashier, Fawry, Valu/BNPL, Meeza, wallets, COD, and the rest available) behind a pluggable provider layer, plus **InstaPay** as a method with ONE manual step (merchant confirms the transfer).
- **Shipping: every available Egyptian carrier** — Bosta, Aramex, and the rest (e.g. J&T, Mylerz, R2S, Sprint, Egypt Post…) behind a pluggable carrier layer (rates, label, tracking webhooks).
- **Language: Arabic-first (RTL default) + English**, like Ebda Store.
- **Pricing/packaging: not decided** — needs research on what to bundle per plan.
- **status.ebda.app: build it** (small, on infra independent of what it monitors).
- **whatsapp.ebda.app: WBS** — fix its backlog, rebrand it for Ebda; Ahmad will create a new Facebook account with the same permissions later. Parked for now.
- **Backend on Cloudflare** (port from Express/Railway), as already planned.
- **Colours + animations stay as decided** (night/Antique Gold, Nile-at-night login).
- **Hosting:** `store.ebda.app` dropped as a separate idea — every store gets `<slug>.ebda.app` free; merchants can attach a custom domain on top (see explanation in session 2026-10-03).
- Mechanical work runs on Sonnet; Opus only for design/security/ambiguous money.

## Questions answered above (kept for history)

- `store.ebda.app`: path-based default stores, or only `<slug>.ebda.app`?
- Language: Arabic-first (RTL default) with English toggle, like Ebda Store storefronts?
- Pricing shown on the site: EGP 0 / 1,500 / 3,500 per month, 15,000 per year — my reading of "at least one fifty", not yet confirmed.
- `status.ebda.app`: hosted status page (e.g. a status provider) or built in?
- `whatsapp.ebda.app`: Ebda's own WhatsApp module, or WBS rebranded?

Brand: night #0A0B0C, Antique Gold #B08D57, lift #CBA873. Nile-at-night animation on the login page (source: `ebda-brief-v2.html`).
