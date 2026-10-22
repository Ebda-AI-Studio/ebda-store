# Launch step 5: impeccable polish pass (5 templates x 3 looks + visual editor)

Status file for a resumable agent. Update the table after every merged PR. Rules: Arabic-first, no per-letter text animation, mirror motion for RTL, no orange in Ebda tokens (brass/gold allowed, METAL-1), Egyptian Arabic full sentences, `git add` specific paths, never `--no-verify`, never touch `qa-walk-store-1010`, one review per PR, minors batched, squash + `--delete-branch`, append a dated register line per merge (`business/ebda/EBDA-PROGRAM-REGISTER.md`). impeccable v4.7.0 is the only design skill.

## Finish line

- **Must work:** every look of every template passes the impeccable critique + audit on home, PLP, PDP, cart, checkout at 390 and 1280, Arabic (default) and English; the editor passes the UX + a11y audit (keyboard path, focus, SR labels, RTL, 390).
- **Exercised:** demo stores `storedemo` (Qamar), `storedemo-souq`, `storedemo-jasmine`, `storedemo-lamma`, `storedemo-dahab` with `?look=<template>.<look>`, or the local stack (matrix configs `playwright.<tpl>.config.ts`).
- **Must NOT change:** pricing/checkout logic, tenant guard, other templates' tokens, merchant colours, no orange.
- **Done:** one PR per template merged on green, deploy pipelines verified, demo store checked live; editor in one or two PRs.

## Cross-cutting fixes (apply once, verify per template)

| ID  | Issue                                                             | PR             | Status |
| --- | ----------------------------------------------------------------- | -------------- | ------ |
| X-1 | `position: sticky` inert (#124): html + body `overflow-x: hidden` | polish-0       | in PR  |
| X-2 | "AI misalignment": alignment, spacing rhythm, baseline grid       | per template   | open   |
| X-3 | Hero heading over image (atelier, vitrine, bloom looks)           | Qamar, Jasmine | open   |
| X-4 | Tap targets >= 44px (Modern skin, Dahab)                          | Dahab + shared | open   |
| X-5 | EP-6 brand-story background for stores with a stored `bgColor`    | Qamar first    | open   |

## Inventory (value order)

Per look run: home, PLP, PDP, cart, checkout x {390, 1280} x {ar, en} = 20 cells.

| #   | Template                | Demo host                   | Looks                                             | PR                      | Status |
| --- | ----------------------- | --------------------------- | ------------------------------------------------- | ----------------------- | ------ |
| 0   | all (X-1 sticky)        | all                         | all                                               | polish-0                | in PR  |
| 1   | Qamar (signup default)  | storedemo                   | qamar.atelier, qamar.lookbook, qamar.vitrine      | polish-qamar            | todo   |
| 2   | Souq                    | storedemo-souq              | souq.catalogue, souq.night, souq.showroom         | polish-souq             | todo   |
| 3   | Jasmine                 | storedemo-jasmine           | jasmine.apothecary, jasmine.bloom, jasmine.clinic | polish-jasmine          | todo   |
| 4   | Lamma                   | storedemo-lamma             | lamma.table, lamma.notebook, lamma.market         | polish-lamma            | todo   |
| 5   | Dahab                   | storedemo-dahab             | dahab.worn, dahab.workshop, dahab.giftbox         | polish-dahab            | todo   |
| 6   | Visual editor (Task 14) | admin `/stores/:id/builder` | n/a                                               | polish-editor (1-2 PRs) | todo   |

## Editor surfaces (Task 14)

Tree/outline, canvas + overlay chips, inline text edit (AR/EN, IME), image swap, "+" insertion, drag reorder, page switcher, look-switch pane, theme pane (incl. 5 ported switches), settings drawers, command-k deep link (`?select=&block=&field=&page=`), undo/redo, publish/preview bar, mobile (390) layout. Audit: axe + keyboard-only path + focus visibility + SR labels + RTL mirroring + 390 overflow.

## Step 3: look-matrix e2e on main

Matrices are local-stack Playwright suites (`playwright.<tpl>.config.ts`, not CI). Needs seeded local stores and a stack per template port (see `docs/ebda/templates/demo-store.md`). Run once on `dcc675117` before the template PRs; record the result in the register. Result: see progress log.

## Verification per PR

`npm run typecheck`, `npm run lint`, touched unit tests, the template matrix for its stores, then after deploy: `api.ebda.app/health` commit = main tip, web deploy workflow success, demo store live check (status, `?look=`, sticky header measured via `getBoundingClientRect` after scroll). State what was NOT verified.

## Progress log

- 2026-10-23: plan written; polish-0 (sticky) started.
