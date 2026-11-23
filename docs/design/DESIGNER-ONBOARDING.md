# Designer onboarding (Ebda Store UI)

Read this first in your Claude Code session. It covers how to work on the Ebda UI redesign without colliding with the rest of the team.

## How you work

- **One long-lived branch.** Create it from `main` (for example `design/marketing-redesign`) and keep all your work on it. Nothing goes to `main` until Ahmad reviews and approves. `main` is protected: changes only land through a pull request that Ahmad merges.
- **Open a draft PR early** from your branch to `main` and keep pushing to it. A draft is never merged or touched by the team's automation. Mark it ready only when Ahmad asks.
- **Pull `main` into your branch now and then** (`git merge origin/main`, never rebase or force-push a shared branch) so your branch stays current.
- **Start with the marketing site** (`apps/marketing`). Your approved design becomes the Ebda design language: it is moved into the shared `ebda-foundation` package (tokens, components, `DESIGN.md`) and then used by the merchant admin, the storefront templates and Ebda Chat.

## Run the marketing site locally

Requirements: Node 20.3+ and npm.

```bash
git clone https://github.com/Ebda-AI-Studio/ebda-store.git
cd ebda-store
npm ci
npm run dev --workspace @ebda/marketing   # http://localhost:3005
```

Useful checks before you push:

```bash
npm run lint --workspace @ebda/marketing
npm run check:a11y --workspace @ebda/marketing
npm run build --workspace @ebda/marketing
```

## Where things live

| What                                                  | Where                                                    |
| ----------------------------------------------------- | -------------------------------------------------------- |
| Marketing site (Next.js, static export)               | `apps/marketing/src`                                     |
| Shared brand constants (names, copy helpers)          | `packages/shared/src/brand`                              |
| Shared UI components                                  | `packages/ui`                                            |
| Design notes                                          | `design.md` (repo root), `brand/`                        |
| Foundation design tokens (vendored, do not edit here) | `packages/shared/src/foundation/tokens.css`, `tokens.ts` |

Files under `packages/shared/src/foundation/` are copied from `ebda-foundation` and checked byte for byte by a test. Don't edit them in this repo. Design token changes go into `ebda-foundation` after your design is approved.

## Brand rules (non-negotiable)

- **No orange** anywhere in Ebda's own design (merchants may still pick orange for their own stores). The palette is night/deep backgrounds with **Ebda gold `#B08D57`**; brass and antique gold count as metal and are allowed.
- **Arabic first, right to left.** Every page must work in Arabic (RTL) and English (LTR). Mirror slide and tab transitions for RTL. **Never animate Arabic text letter by letter**, because it breaks the joined Arabic letters.
- **Copy:** Egyptian Arabic in full sentences for marketing text; neutral wording on buttons; formal language on legal pages. Don't name infrastructure providers (Cloudflare, Gemini, …) in marketing copy.
- **Public copy states only what exists:** Ebda AI Studio, Ebda Store and Ebda Chat are live (present tense). "Coming soon" is only for Ebda CRM, ERP, Invites, Ads and Quote Studio.
- **Master brand:** always "Ebda AI Studio" with products named "Ebda Store", "Ebda Chat". Never a bare "Ebda".
- **Check every screen at 390, 820, 1280 and 1440 px**, in Arabic and English.
- **Motion:** CSS/Tailwind by default; respect `prefers-reduced-motion`. No heavy animation libraries without asking.
- **Performance:** the hero image must not fade in (it is the largest paint); keep each page inside the CSS budget the CI checks.

## Design skill

Use the `impeccable` design skill in Claude Code for critique and polish passes before you push a screen. It is the only design skill the team uses.

## What not to touch

- `packages/shared/src/foundation/**` (vendored, see above)
- Legal texts (`apps/marketing/legal-source`, legal pages): counsel-approved; wording changes need Ahmad's sign-off
- CI workflows (`.github/`), deploy config (`wrangler.jsonc`), API code (`apps/api`)
- Anything outside the UI you were asked to change

## Ask Ahmad when

- a design choice changes a brand rule above,
- you need a new dependency,
- a page needs real data or copy that doesn't exist yet.
