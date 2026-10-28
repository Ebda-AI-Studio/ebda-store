# SEARCH-T13-6

> Section: 2026-10-16 — Search program, PR 4, Task 13 (quality eval): SEARCH-T13-\*

Ruling SEARCH-T13-6 (ACCEPTED by the coordinator) — category names are NOT added to the embed doc. The doc never contained category; adding it means a cross-table subquery inside the hashed doc and a new staleness path (a category rename or a product's category reassignment does not go through the product reindex hooks, so only the 6-hourly backstop would catch it), and the eval cannot measure it (the synthetic store has no categories). Cost if wrong: a product whose name and description never state its type (but its category does) stays harder to find by meaning.
