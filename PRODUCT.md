# Product

## Register
brand — storefront templates: for the shopper, the store's design IS the product experience. (The merchant admin in `apps/admin` is a product-register surface and is out of scope for this file.)

## Platform
web

## Users
- **Primary:** shoppers of Egyptian merchants' stores, on every device — mid-range Android on mobile data, iPhone, and desktop. Arabic-first (RTL), English second. Cash on delivery and InstaPay are common.
- **Secondary:** the merchant, who picks a template at onboarding and tunes it in the visual editor.

## Purpose
Ebda Store gives an Egyptian merchant a storefront that looks like an established brand on day one, then lets them tune every detail without a developer. Each template serves one vertical: Dahab (jewellery and handmade), Qamar (fashion and boutiques), Souq (general retail and electronics), Jasmine (beauty and skincare), Lamma (home food and home kitchens).

## Positioning
Customizable storefronts plus AI on top, built Arabic-first for Egypt (see CLAUDE.md "Strategic positioning").

## First impression
A mix of four feelings, all present by default: trust (a real brand), desire (product-led, I want this), local pride (made here, not translated), ease (fast and simple). The editor lets a merchant lean into any one of them.

## Brand personality
Calm, premium, clear.

## References
- Apple / Aesop / Glossier — quiet premium, large product imagery, very little UI, precise type.
- Zara / COS / Shein — fashion editorial, full-bleed imagery, minimal chrome, scroll-driven.
- Talabat / Instashop / Breadfast — fast ordering, photo-led, big tap targets, local Egyptian feel.

## Anti-references
- A generic Shopify theme.
- Cheap or cluttered: banners everywhere, flashing badges, too many colours.
- Western design with Arabic poured in afterwards: broken RTL, Latin-first fonts.

## Accessibility
WCAG 2.1 AA contrast (tested in CI per template, as Dahab does), nothing under 12px, full keyboard and screen-reader support, `prefers-reduced-motion` respected.

## Launch rule
Ebda Store does not launch until all five templates are built, tested in every scenario, and look stunning (Ahmad, 2026-10-14).
