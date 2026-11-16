# 2026-11-16: Ebda AI Studio social links

Ahmad asked that Ebda AI Studio's public profiles be on the marketing site and that whisky11.com and mypovonai.com point to Ebda AI Studio.

- `BRAND.social` (`packages/shared/src/brand/index.ts`) holds the Instagram, Facebook and LinkedIn URLs. `socialLinks(lang)` (labels and accessible names, ar + en) and `BRAND_SOCIAL_URLS` derive from it. WhatsApp stays `BRAND.contact.whatsapp` (`whatsappUrl()` / `whatsappDisplay()`).
- Footer, all five sites: `siteFooter().brand.social`, rendered by `apps/marketing/src/components/Footer.tsx` and by `siteFooterHtml` (help, docs, status). The `.sf-social` CSS is in `SITE_FOOTER_CSS` and `chrome.css`.
- Contact page: a "Follow us" section under WhatsApp (`socialH` in `content.ts`).
- JSON-LD: the studio Organization (studio home and Ebda Store home) carries `sameAs` = the three profiles. `llms.txt` lists them.
- Guards: `tests/unit/studio-nav-footer.test.tsx`, `marketing-founder-entity.test.ts`, `marketing-seo.test.ts`, `marketing-contact-and-salla.test.tsx`. `marketing-site.test.tsx` allows the LinkedIn company id in its "no registration numbers" scan.
- Sister PRs: Whisky-11/whisky11-site and voidengineer-911/mypovonai-learn carry the same URLs.
