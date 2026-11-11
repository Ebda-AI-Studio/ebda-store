# Ruling DS-FONT-1 - one type family for every Ebda surface

Date: 2026-11-11. Applies to: admin, Ebda Chat, accounts, marketing, help, docs, status. NOT merchant storefront themes (each look keeps its own fonts).

Ruling DS-FONT-1 - the Ebda family uses IBM Plex Sans Arabic for Arabic AND Latin (weights 400/500/600/700, `arabic` + `latin`
subsets), one CSS variable `--font-sans`, no second family. Geist (admin and shell Latin) and Readex Pro (Chat) are retired on
Ebda-owned surfaces; each surface moves in its own PR (admin: this wave; Chat, accounts, marketing, help, docs, status follow).
Evidence (measured in Chromium, same string, 14px): the Arabic sentence "طلباتك الجديدة وصلت، راجعها وجهّزها للشحن النهارده" is
287px in Plex Arabic vs 330px in Readex Pro (+15%) and the Latin sample 390px vs 415px; Readex Pro has NO tabular figures
(digit widths 7 / 8.1 / 8.5 / 8.7 with `tabular-nums`), so prices and counts do not align in tables, while Plex digits are a uniform
8.4px; Plex's Latin removes the second Latin face the admin used beside Arabic text (Geist for English pages, system-ui for Latin
inside Arabic pages, because the Arabic subset carried no Latin). Plex is sober and premium on night + gold; Readex is friendlier
and wider, which costs dense admin tables a sixth of their width. Readex stays a reference for headings only if a surface ever
needs warmth, and then through this ruling, not per surface.
Rules that travel with it: Arabic leading 1.7 at 14px (24px) and the TYPE table's Arabic column (admin: globals.css `[dir=rtl]
.text-*`); never negative or positive letter-spacing on Arabic; weights 400-600 in UI; tabular numerals come from the face, not a
feature flag; scale 12 / 14 / 16 / 18 / 20 / 24 / 30 (shell audit 12/13/15/18/24 is aligned to this scale: 13 and 15 collapse
to 14 and 16).
Cost if wrong: one `next/font` import and one CSS variable per surface revert it; the admin change moves every line box by at
most 4px in Arabic, so layout regressions would be vertical rhythm, not breakage.
