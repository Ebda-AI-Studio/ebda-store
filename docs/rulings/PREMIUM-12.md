# PREMIUM-12

> Section: 2026-11-03 - Storefront premium defaults (PREMIUM-\*)

Ruling PREMIUM-12 - merchant-typed copy (product titles, hero headline/subtitle, section headings) passes through `storefrontText`: Arabic-Indic digits and marks fold to Western (DIGITS-1 stays the rule), and in Arabic each number with its percent sign is wrapped in a left-to-right isolate so '15% 30' cannot reorder. Applied in the template adapters (all card paths), HeroBanner, SectionHeading and the PDP title. Cost if wrong: an isolate character in a copied title; the visible text is unchanged.
