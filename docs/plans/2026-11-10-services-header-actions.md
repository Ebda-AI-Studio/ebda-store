# Header actions: the Menu's pinned pair, the service-page CTA, and the bar's width ladder

Date: 2026-11-10. Owner feedback: "the choose product and whatsapp button are not good there" (service pages, phone).
Rulings: NAV-CTA-2, NAV-MENU-ACTIONS-1, NAV-BAR-FIT-1. Scope: `apps/marketing` only.

## What was measured before

- Phone-sized build, service lines on, 390x844 and 360x740: the header bar holds the wordmark and the Menu button only.
- In the open Menu the WhatsApp pill (81px wide in Arabic), the language link and the gold CTA were three unrelated rows
  at y 1069, 1125 and 1181, inside a panel 754 / 650px tall: 420 to 520px below its fold.
- On a service page the CTA read "اختار منتجك / Choose a product" and led to the product windows on the home page.
- Found while measuring, on production (ebda.app, read-only sweep 320 to 1920px): the header bar runs past the screen
  edge at tablet widths. Arabic from 521 to 752px (156.5px at 600px, the CTA fully off the screen) and from 441 to
  456px; English from 521 to 724px and from 441 to 444px; English from 1480px had 2px to spare. Nothing scrolls,
  because `.site-header` clips sideways (NAV-BAR-FIT-1).

## Finish line

- Must work: with the Menu open on a phone, the CTA and WhatsApp are visible without scrolling, as one pair, both at
  least 44px tall; on a service page the CTA opens the contact form with that service preselected; no header item
  leaves the screen at any width from 320 to 1920px.
- Exercised: the bar on 18 pages in Arabic and English, swept from 320 to 1920px; the open Menu on 7 pages at 13 sizes
  from 360x740 to 1199x700; keyboard focus order; the contact link's topic preselect.
- Must not change: the studio CTA on every other page (NAV-CTA-1), the product bar, `globals.css`, the static header
  of docs, help and status, the footer.
- Done: unit tests green (new `marketing-header-actions`, plus nav, service-lines, footer, lastmod, docs index), the
  measurements above taken from a built site, merged through the gate and re-measured on ebda.app.

## What was built

1. `Header.tsx`: one `li.menu-actions` as the LAST Menu item (CTA + WhatsApp), the language link above it; the old
   `li.menu-wa` and `li.menu-start` rows are gone (the `menu-start` class is on the CTA link now). On a service page
   the CTA is the short `SERVICES_PAGE[locale].headerCta` ("كلّمنا / Talk to us") to `/contact/[?topic=<line>]#form`,
   in the Menu and in the bar.
2. `services-page.ts`: the new `headerCta` label. The hero keeps `contactCta` ("احكيلنا عن شغلك / Tell us about your
   work"); that sentence was the first choice for the header and was dropped, the bar has no room for it.
3. `chrome.css`, the pinned pair: `position: sticky; bottom: -8px` (the panel's own bottom padding), full bleed, wraps
   to two rows when the labels are long; WhatsApp takes the CTA's 10px radius; from 521px the panel gets a max-height
   (less `--ebda-consent-h`) and scrolls inside itself.
4. `chrome.css`, the bar's ladder: up to 520px wordmark, Menu, search; from 521px + WhatsApp; from 680px + language and
   Log in; from 800px + the CTA; from 1200px inline links. Under 800px the CTA shows in the Menu's pair; from 521 to
   679px language and Log in are Menu rows (the language row 44px tall). English from 1480px keeps the 1200px link
   spacing.
5. `globals.css`: NOT changed. Its rules for the old `li.menu-start` still apply to the class on the link; `chrome.css`
   loads after it and sets `display: flex` under 800px. (Follow-up, `docs/plans/2026-11-10-review-followups.md` item 2:
   that relied on import order, so globals.css now hides `.menu-start` only from 800px and has no rule for it below;
   the two ranges never overlap.)
6. Tests: `tests/unit/marketing-header-actions.test.tsx` (markup, labels and links, and that the ladder's CSS rules are
   still there; widths are proven in a browser, not in the unit test).
7. Rulings + index rows; this plan in `docs/README.md`; `npm run lastmod -w apps/marketing` (the header is inside
   every dated page).

## Measured after (built site, service lines on, 2026-11-10)

- Bar sweep, 18 pages, 320 to 1920px: no item past the row's edge, no sideways scroll. Smallest free space, Arabic /
  English: up to 520px 19 / 84.1px; 521 to 679px 32.8 / 113px; 680 to 799px 55.4 / 140.6px; 800 to 1199px 43.5 /
  71.9px; 1200 to 1479px 87.2 / 43.4px; 1480px up 76.7 / 38px. Web fonts blocked (6 pages): smallest 46 / 42.8px.
- Open Menu, 7 pages x 13 sizes, consent bar removed: 91 of 91 trials pass (pair in view and on the panel's edge, last
  link 13.8 to 14px above it, CTA and WhatsApp 44px tall, no link under 44px).
- Landing: `/contact/?topic=marketing#form`, `/en/contact/?topic=design#form`, `/contact/#form`; form top 65px =
  header bottom 65px; topic preselected.
- Keyboard: 17 / 17 / 13 links take focus, none hidden, all with a 3px outline. Contrast: CTA 6.37:1, WhatsApp 18.6:1
  (one colour scheme).

## Not in this change

- The static header from `siteNavHtml` in `packages/shared/src/brand` (docs, help, status): its own `li.menu-cta`, no
  WhatsApp in the nav; not measured here.
- The phone panel's `max-height` in `globals.css` and `--ebda-consent-h` itself: another change sets them. Until it is
  in, the consent bar covers the pinned pair on a first visit (91 of 91 trials with the bar showing, by 104 to
  123.5px).
