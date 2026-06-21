# Force AI Platform Landing Redesign

> **For agentic workers:** Build section-by-section on the `/landing-preview` route. Recolor every 21st.dev component to Force brand BEFORE shipping. Heavy/canvas deps are `dynamic(ssr:false)`.

**Goal:** Rebuild the Force AI platform landing (`store.forcemediakw.com` → `apps/web/src/components/PlatformLanding.tsx`) using curated 21st.dev components, recolored to the Force brand, assembled section-by-section as Ahmad feeds prompts.

**Architecture:** Drop 21st.dev components under `apps/web/src/components/ui/` (shadcn target; `@/*`→`src/*` already resolves; `cn` shimmed from `@force/ui` via `src/lib/utils.ts`). Compose them into section components under `apps/web/src/components/landing/`. Iterate on an isolated `/landing-preview` route so the live landing never breaks mid-build. Swap into `page.tsx` only on Ahmad's sign-off.

**Tech stack:** Next.js 16 App Router, Tailwind, TS. New deps: `three` (WebGL hero), `framer-motion` + `motion` (animation), `@tsparticles/{react,slim,engine}` (sparkles), `class-variance-authority` + `@radix-ui/react-slot` + `@radix-ui/react-icons` (buttons/badge/card), `clsx` + `tailwind-merge` (cn — already transitively in @force/ui), `color-bits` (flickering footer), `lucide-react` (icons), `react-use-measure` (infinite slider).

## Brand recolor rule (applies to EVERY component)

Force brand = **orange `#ff6e01` / white / black / grey**. Storefront tokens already defined in `globals.css`: `--primary: 26 100% 50%`, `--background`, `--foreground`, `--muted-foreground`, `--border`, `--card`.

Replace the components' shipped palettes:

- WebGL shader fragment: the RGB-split sine field → tint toward orange (warm the `r`, mute `b`) on black.
- ~~radial-orbital-timeline~~ — REPLACED 2026-06-21: the orbital read as a gimmicky full-screen, click-to-expand toy that hid the capabilities. Features is now a scannable **bento grid** (`FeaturesSection.tsx`, no external component) with the AI flagship as the 2×2 tile; AEO/GEO dropped here to stay complementary with `AeoGeoSection`. Card idiom matches AeoGeoSection (glass + orange icon chip + hover lift/glow). The orbital component + its purple/blue palette are gone.
- sparkles: `particleColor="#ffffff"` on black, accent gradients `via-indigo-500`/`via-sky-500` → `via-primary`.
- testimonial-cards: `border-slate-700 bg-slate-800/20`, `text-indigo-400` author → `border-border bg-card/40`, `text-primary`.
- logo-cloud: real Force client/tech logos via lucide or `logo_search` MCP, not the svgl defaults.
- flickering-footer: `color="#6B7280"` grid + Tremor blue focus rings → grey grid + brand text; swap the placeholder SOC2/HIPAA/GDPR badges (Force isn't SOC2-audited — DON'T claim compliance we don't have; drop those badges or replace with real Kuwait-relevant trust signals).
- ai-chat-image-generation, liquid-glass-button, hover-play-card, animated-text-cycle, image-comparison-slider: neutral — keep, theme via tokens.

## Section map (Ahmad feeds these incrementally)

| #   | Section          | Primary component(s)                                            | Status                             |
| --- | ---------------- | --------------------------------------------------------------- | ---------------------------------- |
| 1   | Hero             | `web-gl-shader` + `liquid-glass-button` + `animated-text-cycle` | ✅ built (PR #333)                 |
| 2   | Features         | bento grid (`FeaturesSection.tsx`)                              | ✅ rebuilt — orbital replaced      |
| 3   | CTA              | `sparkles`                                                      | ✅ built (PR #333)                 |
| 4   | Buttons (system) | `liquid-glass-button` (LiquidButton + MetalButton)              | ✅ built (PR #333)                 |
| 5   | Testimonials     | `testimonial-cards`                                             | ✅ built (PR #333)                 |
| 6   | Clients          | `logo-cloud-4` (+ `infinite-slider`, `progressive-blur`)        | ✅ built (PR #333)                 |
| 7   | Before/After     | `image-comparison-slider`                                       | ✅ built (PR #333)                 |
| 8   | Footer           | `flickering-footer`                                             | ✅ built (PR #333, badges dropped) |
| -   | AI demo          | `ai-chat-image-generation-1`                                    | optional — not built               |
| -   | Video            | `hover-play-card`                                               | optional — not built               |

**Build note (2026-06-21):** `@tsparticles/*` was pinned to **v3**, not v4 — v4.2.1 dropped the `initParticlesEngine` named export the sparkles component uses (v4 moved to a `ParticlesProvider`/`useParticlesProvider` API). All three (`react`/`slim`/`engine`) must match major. Section export styles vary (Hero/Before/Testimonials/Clients/Footer are named exports; Features/Buttons/Cta are default) — see `landing-preview/page.tsx` for the import mix.

## Guardrails (non-negotiable)

1. **Dependency discipline** — every new dep registry-real, MIT/permissive, <12mo active, `npm audit` 0 high/critical. `three` + `@tsparticles/*` are large → `dynamic(() => import(...), { ssr: false })` so they never enter shared route bundles.
2. **No false compliance claims** — drop/replace the footer's SOC2/HIPAA/GDPR badges unless Force actually holds them.
3. **Typing + a11y** — type the untyped props (`testimonial-cards`, `image-comparison-slider` are plain JS) before commit (tsc is a CI gate). Honor `prefers-reduced-motion` for shader/particles.
4. **Bilingual** — platform landing copy is EN/AR; new copy routes through the same i18n the existing PlatformLanding uses.
5. **Preview-first** — `/landing-preview` until sign-off; never edit `page.tsx`/`PlatformLanding.tsx` live until approved.
6. **Isolate canvas perf** — pause the WebGL/particle RAF loops when offscreen / on `prefers-reduced-motion`.

## Source assets

Raw 21st.dev component sources are catalogued here; materialize each under `src/components/ui/<name>.tsx` as its section is built, recolored per the rule above. (Original dark-theme sources preserved in the chat that seeded this plan — 2026-06-21.)
