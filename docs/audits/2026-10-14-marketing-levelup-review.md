⚠️ DEGRADED: single-context (ran as a delegated subagent told to do the work itself; Assessment A, the design review, was written before the detector output was read)

# ebda.app: level-up review and 3D replacement

Date: 2026-10-14 · Target: https://ebda.app/ (ar) and https://ebda.app/en · Source (read-only): `Ebda-AI-Studio/internal-projects/ebda-store/apps/marketing`
Evidence key: **[M]** = measured this session (screenshot, DOM metric, API or HTTP response) · **[I]** = inferred (judgement, or an estimate not yet run)

Screenshots are in `scratchpad/live/`: `{ar,en}-{390,1440}-full.png`, plus slices `*-full-N.png` and fold shots `*-fold.png`.

---

## 0. What the live site is today [M]

The page runs in this order. Heights are at 1440 px; the 390 px heights are in brackets.

| #   | Section    | Height          | What it shows                                                                                                                                                                    |
| --- | ---------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | hero       | 820 (776)       | Particle "dust stream" (NileNight), gold kicker "ابدأ ستوديو للذكاء الاصطناعي — بابك لبدء مشروعك.", h1 "ابدأ متجرك أونلاين في دقايق.", two CTAs, and a `yourstore.ebda.app` pill |
| 2   | story      | **3060 (2870)** | A sticky Dahab phone with 4 numbered lines: "اختار اسم ولوجو / نزّل منتجاتك / ظبّط ألوانك / وأول طلب يوصلك"                                                                      |
| 3   | how        | 600 (966)       | **4 more numbered steps** in gold-ringed cards (01–04): sign up / add products / pick a look / receive orders                                                                    |
| 4   | templates  | 1014 (606)      | Dahab laptop, tablet and phone frames (night + gold)                                                                                                                             |
| 5   | breakout   | **2700 (2532)** | Outline-stroke "ابدأ دلوقتي" words behind a Dahab phone                                                                                                                          |
| 6   | dahab (3D) | 1170 (880)      | Procedural three.js ring on a full gold field, metal and stone chips                                                                                                             |
| 7   | features   | 891             | 8 items in a 2-column ruled list                                                                                                                                                 |
| 8   | payments   | 713             | Logo rails: payment (COD, InstaPay, Paymob, Kashier, Fawry) and shipping (Bosta, ShipBlu, Mylerz, Aramex, self-delivery)                                                         |
| 9   | about      | 857             | "حكاية ابدأ ستوديو للذكاء الاصطناعي": 3 paragraphs plus the arch mark                                                                                                            |
| 10  | pricing    | 2042 (**2840**) | 3 plan cards (1,490 / 3,490 / 9,990 EGP) and a 14-row comparison table                                                                                                           |
| 11  | faq        | 780             | 7 questions                                                                                                                                                                      |
| 12  | start      | 524             | "الدور عليك." and 2 CTAs                                                                                                                                                         |
| –   | footer     | 300             |                                                                                                                                                                                  |

Other measurements:

- Total page height is 15,535 px at 1440 and 16,053 px at 390 (ar).
- 63 requests and about 571 KB transferred on mobile before the 3D scene loads. The largest file is `dahab-story-900.avif` at 177 KB.
- No console errors.
- Security headers are good: HSTS preload, frame-ancestors none, nosniff.
- One font family carries all Arabic: IBM Plex Sans Arabic. English uses Geist.
- h1 is 84 px at 1440 and 41.6 px at 390. Arabic letter-spacing is `normal`; English is −0.03em.
- Text renders as small as **8.7 px and 9.67 px** at 390. It sits inside the device-mockup UI.
- `FIRST_MERCHANT = null` in `src/lib/site.ts`, so the page has **zero customer proof**.
- The page already shows real prices (`PRICING_PUBLISHED = true`).

The product already ships a real 3D viewer [M]. `packages/ui/src/model3d/ProductModelViewer.tsx` is GLTFLoader plus the meshopt decoder, with AR hand-off (USDZ, a generated USDZ, or Scene Viewer). `packages/shared/src/model3d.ts` sets a 15 MB cap and supports `KHR_materials_variants`. It **rejects Draco and KTX2** (Ruling R-EBDA-3D-3). This changes the 3D answer (§2).

---

## 1. Critique

### Design Health Score (Nielsen, adapted to a marketing surface)

| #         | Heuristic                       | Score     | Key issue                                                                                                                                                                                                                         |
| --------- | ------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1         | Visibility of system status     | 3         | The sticky nav and story-step highlighting work. A scroll runway gives no sense of "how much more" (3,060 px story)                                                                                                               |
| 2         | Match system / real world       | 3         | Egyptian colloquial is excellent ("ابدأ دلوقتي", "باقة على قد متجرك"). But the wordmark, kicker and About section all say "ابدأ ستوديو للذكاء الاصطناعي", a company name, where a merchant expects "Ebda Store"                   |
| 3         | User control and freedom        | 3         | Plain scrolling and an FAQ. About 5,700 px of sticky runway (story + breakout) feels like scroll-jacking on mobile                                                                                                                |
| 4         | Consistency and standards       | **2**     | Two 4-step sequences back to back (story, then how). The site wears the **retired** night + gold Dahab look while the product's 5×3 looks are light, varied and colourful. The brand name changes between header, hero and footer |
| 5         | Error prevention                | 3         | Pricing is clear: annual price, 0% commission, gateway fees called out                                                                                                                                                            |
| 6         | Recognition rather than recall  | 3         | Plan comparison table, logo rails                                                                                                                                                                                                 |
| 7         | Flexibility and efficiency      | **2**     | No way to see a real store, browse templates or reach WhatsApp. The only path is signup                                                                                                                                           |
| 8         | Aesthetic and minimalist design | **2**     | The particle dust, outline-stroke "ابدأ دلوقتي" wall, gold-glow ringed 01–04 cards and empty runways read as generic AI dark-luxury, not "calm, premium, clear"                                                                   |
| 9         | Error recovery                  | 3         | n/a for most of the page; the 404 exists                                                                                                                                                                                          |
| 10        | Help and documentation          | **2**     | 7 FAQs and an email address only. No WhatsApp, which Egyptian SMB buyers expect                                                                                                                                                   |
| **Total** |                                 | **26/40** | **Acceptable**: the bones are sound (copy voice, pricing, logos), but the surface fights the product                                                                                                                              |

### Anti-patterns verdict

- **LLM assessment [I]:** yes, a first-time visitor could say "AI made this". The tells:
  - near-black canvas with one gold accent (the "fintech/luxury dark" category reflex)
  - a particle/starfield hero with no product in it
  - numbered 01–04 cards with a glowing conic border
  - a giant outline-stroke word wall
  - a gold kicker above the h1

  None is a hard ban on its own. Together they are the saturated "premium dark SaaS" lane, and the second-order reflex check fails: "store builder that isn't Shopify-white → black + gold" is guessable from the category.

- **Deterministic scan [M]:** `detect.mjs --json src` returned `[]` (0 findings, exit 0). Caveat: the detector reads HTML/CSS patterns and the markup here is TSX with CSS in `globals.css`, so treat "0" as weak evidence. The manual scan found no side-stripes, no gradient text and no 32 px+ card radius (`.step4` is 16 px).
- **Visual overlays:** not attempted (no live server or overlay injection). Screenshots came from a headless Chrome / Playwright capture.

### Overall impression

The copy is the best asset: short, colloquial and confident. The visual layer sells a different product from the one being built. Five vertical templates in light, varied looks are about to launch, but the marketing site wears one retired look (night + gold Dahab) and shows only one vertical (jewellery) in every mockup. **The single biggest opportunity is to make the looks the hero and let the site's own chrome get quiet**, so the colour comes from the merchants' stores, the way Apple lets the product carry the colour.

### What's working

1. **Voice.** "ابدأ متجرك أونلاين في دقايق." puns on the brand name and reads like a person talking. "باقة على قد متجرك." and "الدفع والشحن، زي ما عملاءك متعودين." are Talabat-grade local ease.
2. **Payments and shipping rails.** Real Egyptian logos (InstaPay, Fawry, Bosta, ShipBlu) are the strongest trust signal on the page, and they are calm.
3. **Pricing honesty.** Real EGP numbers, 0% commission, a 14-day trial and an annual saving visible up front. Most competitors hide this.

### Priority issues

- **[P0] The site skin is the retired look.**
  - _Why:_ `globals.css` is "night canvas, Antique Gold accents", and every mockup is Dahab night + gold. Once the looks section lands (light Qamar, green Souq, pink and green Dahab gift box), the page will hold two contradictory brands. Gold-on-black also says "jewellery", which narrows Ebda to one vertical.
  - _Fix:_ move the canvas to a neutral light surface: true off-white at chroma ≈ 0.005 toward the brand hue, not cream. Keep ink near-black and keep gold only as the brand accent (CTA, the arch mark). Use dark bands deliberately for one or two moments (the 3D stage, the closing CTA).
  - _Command:_ `$impeccable colorize`, then `quieter`.
- **[P0] The hero shows no product.** _(evidence: ar-1440-fold.png, ar-390-fold.png)_
  - _Why:_ the fold is particle dust plus text. Every PRODUCT.md reference (Apple, Aesop, Zara, Talabat) leads with the product, and an ad click has about 3 s to see "a store like mine".
  - _Fix:_ hero = the h1 plus one tall phone from the looks system auto-cycling through 3–5 stores (crossfade, 4 s each, pausable), each labelled with its vertical. Drop NileNight. Drop the `yourstore.ebda.app` pill or fold it into the phone's address bar.
  - _Command:_ `$impeccable layout` + `animate`.
- **[P1] Duplicated 4-step story and about 5,700 px of runway.** _(evidence: ar-1440-full-0/1/3.png, mostly empty frames)_
  - _Why:_ "story" and "how" say the same thing twice. Breakout's outline "ابدأ دلوقتي" wall adds nothing. Story + breakout are 37% of page height at 1440 [M: (3060+2700)/15535]. On mid-range Android, sticky + scroll-linked animation is jank risk [I].
  - _Fix:_ delete breakout. Merge story and how into one 4-step band, built only if it uses looks frames, otherwise a plain numbered list (it IS a real sequence, so numbers are earned once).
  - _Command:_ `$impeccable distill`.
- **[P1] Zero proof.**
  - _Why:_ `FIRST_MERCHANT = null`. There is no live store link, no merchant name or quote, and no count. For a 1,490–9,990 EGP/month decision, trust is the gate.
  - _Fix:_ before ads, ship one real or demo store at a real URL ("شوف متجر حقيقي") plus a merchant quote with face and city. Until a merchant exists, link the 5 looks as browsable demo stores.
  - _Command:_ `$impeccable clarify`.
- **[P1] Brand-name confusion.**
  - _Why:_ the header wordmark, hero kicker and About all say "ابدأ ستوديو للذكاء الاصطناعي" (the studio). Merchants are buying **Ebda Store**. The About section (857 px) is company philosophy on a conversion page.
  - _Fix:_ use "ابدأ ستور" in the header and hero. Move the studio to the footer line ("ابدأ ستور منتج من ابدأ ستوديو") and the full story to `/about`, which already exists.
  - _Command:_ `$impeccable clarify`.

### Persona red flags

- **Casey (distracted mobile, the ad click):**
  - The 390 px fold has no store image (measured).
  - The first product glimpse is 900 px down.
  - Pricing is 2,840 px tall on mobile: 3 stacked cards plus a 14-row table.
  - No WhatsApp anywhere.
- **Jordan (first-timer merchant):**
  - "MCP", "API", "CSV" and "شيل «مدعوم من ابدأ ستور»" appear in plan bullets and comparison rows without explanation.
  - "ذكاء اصطناعي" sits in the company name but is barely shown in the product.
- **Sam (accessibility):**
  - 8.7–9.7 px text inside mockups (below the 12 px floor in PRODUCT.md).
  - Gold `#b8955b`-ish on near-black passes for large text [I]. Gold sub-copy in the hero at ~24 px is borderline and should be checked with a contrast tool, not eyeballed.
  - The ring has a reduced-motion poster path, which is good [M from source].
- **Project persona: Hoda, home-kitchen seller in Mansoura (Lamma vertical):**
  - Every image is gold jewellery; nothing tells her "this is for food too".
  - The looks section fixes this only if it appears early (position 2), not after the story.

### Minor observations

- **Mobile header:** the wordmark sits on its own row above "القائمة / English / ابدأ دلوقتي" [M ar-390-fold], so the header costs ~90 px.
- **Typography:**
  - IBM Plex Sans Arabic is one family at weights 400–700. It is clean but generic, and it is on the impeccable reflex list (as the Plex family). It is existing identity, so this is not a ban.
  - For the display h1 only, consider **Alexandria** (Google Fonts, designed by Egyptian type designer Mohamed Gaber). That is a local-pride signal at zero licence cost [I]. Match whatever the looks section uses.
- **Feature list:** 8 equal items in a ruled list. It would be stronger as 3 "hero" features tied to visuals (editor, WhatsApp orders, AI descriptions) plus a compact rest.
- **Closing CTA:** "عندك متجر؟ ادخل" as a secondary CTA at the close is a login link dressed as a CTA; demote it to a text link.

### Questions to consider

- What if the site had no "colour" of its own, and the five stores were the only colour on the page?
- Would a merchant trust this more with one real store link than with any animation?
- Should each vertical get its own ad landing (`/souq`, `/lamma` …) that opens on its look?

---

## 2. The 3D section: replace the procedural ring

**The job:** sell "upload a .glb, and shoppers spin it, swap variants and see it in AR on your product page."

**What's wrong with the current ring [M/I]:**

- It is procedural geometry. It reads as a CG demo, not a merchant's product.
- It is jewellery-only, and sits on a full gold field (the retired Dahab palette).
- It is a separate renderer from the real `ProductModelViewer`. So it demos a capability the product implements differently, and AR, the actual wow, is absent.

### Candidate assets (all verified this session) [M]

| Asset                                                                                                     | Source / URL                                                                                                                                                                                 | Licence                                              | Triangles      | Raw size                                        | After optimisation [I]                                                  |
| --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | -------------- | ----------------------------------------------- | ----------------------------------------------------------------------- |
| **Brass Diya Lantern**                                                                                    | Poly Haven `brass_diya_lantern` · https://polyhaven.com/a/brass_diya_lantern · 1k glTF: https://dl.polyhaven.org/file/ph-assets/Models/gltf/1k/brass_diya_lantern/brass_diya_lantern_1k.gltf | **CC0** (Poly Haven site-wide; author Bhargav Kubal) | 12,742         | 1.97 MB (1k) / 5.48 MB (2k)                     | ~0.8–1.2 MB as meshopt + WebP 1k GLB                                    |
| **MaterialsVariantsShoe** (sneaker, 3 colourways: midnight / beach / street via `KHR_materials_variants`) | Khronos glTF-Sample-Assets · https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/MaterialsVariantsShoe                                                                       | **CC-BY 4.0** (Shopify), attribution required        | 22,700         | 7.83 MB GLB (7.12 MB of that is 5 PNG textures) | ~1.0–1.6 MB with WebP 1k textures                                       |
| Lantern 01 (rustic hanging lantern)                                                                       | Poly Haven `Lantern_01` · https://polyhaven.com/a/Lantern_01                                                                                                                                 | CC0                                                  | 33,902         | 1.42 MB (1k)                                    | ~0.8 MB                                                                 |
| Brass Vase 01                                                                                             | Poly Haven `brass_vase_01` · https://polyhaven.com/a/brass_vase_01                                                                                                                           | CC0                                                  | 21,440         | 0.84 MB (1k)                                    | ~0.5 MB                                                                 |
| Tea Set 01 (Lamma / home)                                                                                 | Poly Haven `tea_set_01` · https://polyhaven.com/a/tea_set_01                                                                                                                                 | CC0                                                  | 40,296         | 2.28 MB (1k)                                    | ~1.2 MB                                                                 |
| GlamVelvetSofa (5 colour variants)                                                                        | Khronos · https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/GlamVelvetSofa                                                                                                 | CC-BY 4.0 (Eric Chadwick)                            | 4,196          | 3.15 MB GLB                                     | ~1 MB                                                                   |
| SheenChair (variants)                                                                                     | Khronos `SheenChair`                                                                                                                                                                         | **CC0**                                              | n/m            | 4.13 MB GLB                                     | ~1.2 MB                                                                 |
| Perfume bottles (museum scans)                                                                            | Sketchfab CC0, e.g. "Oriental perfume bottle" https://sketchfab.com/3d-models/none-3c659d071d7e4bb39e3a745eaf3bc98f                                                                          | CC0                                                  | 59k–222k faces | 20–41 MB GLB                                    | needs heavy decimation; antique, not modern beauty. **Not recommended** |

Notes:

- **Jewellery:** no good CC0/CC-BY photoreal jewellery piece under 3 MB was found. The Sketchfab CC0 hits are museum medallions at 118 MB.
- **Jasmine (beauty):** no clean modern perfume or skincare bottle was found under CC0/CC-BY. The honest options are a simple in-house Blender bottle (glass via `KHR_materials_transmission` + `volume`, which the viewer supports; about half a day of work [I]) or skipping that vertical.
- **Compression rule:** Draco is not allowed. The product viewer rejects `KHR_draco_mesh_compression` (R-EBDA-3D-3), so the demo assets must be **meshopt + WebP** to prove the same pipeline merchants use. Prep command: `gltf-transform optimize in.glb out.glb --compress meshopt --texture-compress webp --texture-size 1024`. The output must be validated with `packages/shared/src/model3d.ts`.

### Option A: "Your product page, live" (RECOMMENDED)

A phone mockup built from **the same frame component as the looks section**, showing a look's _product page_. The media slot runs the **real `ProductModelViewer`**, not a separate scene. Above it sit vertical chips:

- **قمر** loads the sneaker on the Qamar look, with its 3 colourways as variant swatches.
- **سوق** / **لمّة** loads the brass diya lantern on the Night-souq look (or the tea set for Lamma).
- **دهب** stays as a slot for when a real jewellery GLB exists.

On desktop, beside the phone, the AR button shows a QR code ("وجّه كاميرا موبايلك"). On phones it opens Quick Look or Scene Viewer directly.

| Criterion   | Assessment                                                                                                                                                                                           |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wow         | High: photoreal brass and leather, variant swaps, real AR in the visitor's own room                                                                                                                  |
| Relevance   | Highest: it IS the shopper experience the merchant buys, and it ties directly to the looks section                                                                                                   |
| Performance | Same lazy path as today (poster AVIF, then the viewer once within ~1 viewport). One model at a time (~1–1.5 MB [I]); the next chip's model preloads only on hover/focus. three.js is already shipped |
| Licence     | Lantern CC0. Shoe CC-BY: add "Sneaker model: Shopify, CC BY 4.0" to `public/demo/CREDITS.md` and a small credit line under the stage                                                                 |
| Conflicts   | None. It reuses the looks frame and palette. Retire the gold-field stage                                                                                                                             |

### Option B: single hero object, full-bleed

One brass diya lantern, large, on a committed dark-indigo stage. Scrolling turns it, and a "نوّر" toggle lights its emissive flame, casting a pattern on the wall.

- **Wow:** highest single-moment wow.
- **Relevance:** narrow. One vertical, and it doesn't show _a store_.
- **Performance:** good (~1 MB).
- **Licence:** CC0.
- **Verdict:** a great P2 ad creative, but a weaker selling section.

### Option C: AR-first

A large QR code and "حطّه في أوضتك" with the sofa or lantern. Desktop shows the QR; mobile goes straight to AR.

- **Wow:** high for the few who try it.
- **Relevance:** good.
- **Engagement:** low [I]. Most mobile visitors won't leave the page.
- **Verdict:** use it as the AR affordance _inside_ Option A rather than as the section.

### Option A interaction design

- **Default state:** the Qamar sneaker (the variants are the most legible "aha"), idling at 0.15 rad/s.
- **Scroll-turn:** 0 → 1.2 turns across the section's own height. No sticky runway.
- **Drag:** horizontal drag spins it with inertia (keep the current 0.94 damping). Vertical drag tilts ±15°. Pinch zooms 1–1.6× inside the phone.
- **Swatches:**
  - 3 round chips under the phone, wired to `KHR_materials_variants`.
  - The selected chip has a 2 px ring in ink.
  - Labels are visible text, not colour alone.
  - Arrow keys move between chips. `aria-pressed` on each chip.
- **Vertical chips:**
  - "قمر / سوق / لمّة" act as a tablist.
  - Switching crossfades the phone's look skin (200 ms, ease-out-quart) and loads the next GLB behind the poster.
- **AR button:**
  - Labelled "شوفه في مكانك" / "View in your space".
  - Desktop: a popover with a QR code to the same model.
  - iOS: `rel="ar"` USDZ.
  - Android: Scene Viewer intent.
  - Hidden when unsupported.
- **Reduced motion / no WebGL / Save-Data:**
  - A per-variant AVIF still (render 3 stills per model at build time). Swatches swap stills.
  - No idle spin and no scroll-turn. The AR button still works.
- **Loading:** poster, then the canvas fades in (300 ms) only after the first frame renders. Never a blank box.

### Copy

- **ar (Egyptian):**
  - Title: **"خلّي عميلك يقلّب المنتج بإيده."**
  - Lead: "ارفع موديل 3D لمنتجك، وعميلك يلفّه ويغيّر لونه ويشوفه في أوضته، من صفحة المنتج على متجرك."
  - Hint: "اسحب علشان تلفّه"
  - AR: "شوفه في مكانك"
  - Footnote: "متاح في كل الباقات."
- **en:**
  - Title: **"Let shoppers turn it in their hands."**
  - Lead: "Upload a 3D model and customers spin it, switch colours and place it in their room, right on your product page."
  - Hint: "Drag to turn"
  - AR: "View in your space"
  - Footnote: "Included on every plan."

The "every plan" footnote is grounded: the comparison row "موديلات 3D للمنتجات" is ✓ on all 3 plans [M].

---

## 3. Level-up plan

### P0: before any ad spend

1. **Swap the night + gold skin for a quiet light canvas.** Gold becomes accent-only, and the looks carry the colour. _Effect:_ the site stops contradicting the product and stops reading as "jewellery only". (This is required by the looks section, not a conflict with it.)
2. **New hero: h1 + one cycling looks-phone (5 verticals) + one primary CTA.** Drop NileNight and the studio kicker. _Effect:_ the product is visible in the first viewport at 390 px; the first-second answer becomes "a store like mine".
3. **New section order:**
   1. hero
   2. **looks** (the section being built)
   3. how (story and how merged; 4 steps, once)
   4. 3D (Option A)
   5. payments & shipping
   6. features (condensed)
   7. pricing
   8. FAQ
   9. close

   _Effect:_ the strongest asset sits at position 2, and the page drops from about 15.5k px to about 9–10k px [I].

4. **Delete breakout and the story runway.** _Effect:_ removes 37% of page height [M] and the sticky-scroll jank risk on mid-range Android.
5. **Name the product "ابدأ ستور / Ebda Store"** in the header and hero, and move the studio story to `/about` plus a footer line. _Effect:_ one clear brand at the decision point.
6. **Proof:** one real (or demo) store URL ("شوف متجر شغال") plus a merchant name, city and quote as soon as one exists (`FIRST_MERCHANT`). _Effect:_ moves the trust gate before the pricing ask.
7. **WhatsApp contact** in the header, FAQ and close (wa.me link). _Effect:_ the expected channel for Egyptian SMB pre-sales, and it lifts conversion for hesitant merchants [I].
8. **Ad readiness:**
   - Conversion events on the signup CTAs.
   - UTM pass-through to `SIGNUP_URL`.
   - OG image per locale.
   - **NOT VERIFIED:** whether analytics or a pixel exist at all. I did not check `RootShell`. Settle it with `grep -rn "gtag\|fbq\|plausible\|posthog" apps/marketing/src`.

   _Effect:_ ad spend is measurable.

### P1

1. **3D section as Option A** (real viewer in a looks phone; sneaker + lantern; AR QR). _Effect:_ it sells the actual feature, and AR is the wow.
2. **Pricing on mobile:** a plan switcher (segmented control) instead of 3 stacked cards, and the comparison table collapsed behind "قارن الباقات". _Effect:_ 2,840 px becomes about 1,100 px [I].
3. **Plain-language plan bullets:** replace "MCP/API", "شيل «مدعوم من…»" and "CSV" with outcomes ("اربط متجرك بأي برنامج", "شيل علامة ابدأ ستور"). _Effect:_ first-timers aren't lost at the money moment.
4. **Features:** 3 hero features, each with a visual from the looks/admin (editor, WhatsApp order, AI description), plus a compact list of the rest. _Effect:_ removes an equal-weight wall of 8.
5. **Display type:** test Alexandria (Egyptian designer) for h1/h2 only, keeping Plex Arabic for body, and align with the looks section's type. _Effect:_ local pride carried by type, not palette.
6. **Motion:** one orchestrated hero load (h1 rise + phone settle, ≤ 600 ms, expo-out) plus the looks crossfade. No per-section fade reflex. Full `prefers-reduced-motion` path. _Effect:_ calm premium instead of decorative motion.
7. **Accessibility pass:** contrast-check gold on the new canvas; nothing under 12 px outside screenshots; keyboard order through the looks tabs and the 3D chips. _Effect:_ meets the PRODUCT.md AA promise that CI already enforces on templates.

### P2

1. **Per-vertical ad landings** (`/qamar`, `/souq`, `/jasmine`, `/lamma`, `/dahab`) that open on that vertical's look and 3D object. _Effect:_ ad-to-page message match, a higher Quality Score and better CVR [I].
2. **Option B lantern as a short ad/OG video** (scroll-turn render, ~6 s). _Effect:_ a reusable social creative from the same asset.
3. **Commission a Jasmine bottle and a Dahab piece as GLB** (meshopt, < 1.5 MB each). _Effect:_ completes the 3D chip set across all verticals.
4. **Merchant story video** once there is a first merchant (30 s, phone-shot, Egyptian). _Effect:_ the strongest proof format for this audience [I].
5. **Performance budget in CI:** mobile LCP < 2.5 s and JS < 200 KB before the 3D loads. _Effect:_ keeps the page light as looks and 3D are added.

### Conflicts with the looks section

- **None of the items above conflict with it.** Items P0-1, P0-2 and P1-1 _depend_ on the looks frame component, so build that component reusable: phone frame + look skin + a product-page variant.
- **One thing to decide:** if the looks section uses its own dark page background (the review artifact uses a dark canvas around the phones), the marketing canvas change in P0-1 should make the looks band the one deliberate dark moment, or both go light. Decide once and don't mix.

---

## Run notes

| Item                    | Status                                                                                                                                               |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Assessment independence | Degraded (single context); banner at top                                                                                                             |
| CLI detector            | Ran, `[]`, exit 0 (limited TSX coverage)                                                                                                             |
| Browser                 | Headless Chrome via Playwright: 4 full-page captures plus 4 fold captures, DOM metrics, network totals. No overlay injection; no live server started |
| Temp files              | `scratchpad/live/*.png`, `scratchpad/dl/*` (downloaded GLBs and JSON, untrusted data, parsed with `python3 -I`)                                      |
| Repository edits        | None                                                                                                                                                 |
