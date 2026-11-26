# 2026-11-16: Ebda AI Studio social links (contact page, llms.txt)

Ahmad asked that Ebda AI Studio's public profiles be on the marketing site.

- The profile list is the foundation's `EBDA.social` (vendored at `packages/shared/src/foundation/brand.ts`), exported as `SOCIAL_SAME_AS` and `siteFooter().brand.social` from `packages/shared/src/brand/index.ts`. Footer and Organization JSON-LD `sameAs` come from #948; this change adds only the surfaces below.
- Contact page: a "Follow us" section under WhatsApp (`socialH` in `content.ts`), rendered from `siteFooter(locale).brand.social`.
- `llms.txt` lists the profiles (Instagram is `https://www.instagram.com/ebdaai.studio/`; Meta closed the old handle).
- Guards: `tests/unit/marketing-contact-and-salla.test.tsx`, `tests/unit/marketing-founder-entity.test.ts` (both read `SOCIAL_SAME_AS`, never retyped URLs).
- Sister PRs: Whisky-11/whisky11-site and voidengineer-911/mypovonai-learn carry the same URLs.
