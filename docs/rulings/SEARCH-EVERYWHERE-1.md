# SEARCH-EVERYWHERE-1

> Section: 2026-10-26 — Search as you type (plan `docs/plans/2026-10-26-search-as-you-type.md`)

Ruling SEARCH-EVERYWHERE-1 — search-as-you-type is already in all five storefront headers; no code was added to them. qamar, souq, jasmine and lamma render the shared `templates/base/Header.tsx` (which mounts `SearchAutocomplete`), dahab mounts it in its own header. The audit row "only the base header" was wrong: those four are wrappers, not copies. `tests/unit/search-everywhere-headers.test.tsx` now renders all five and asserts the input becomes an ARIA combobox with a listbox after ONE Arabic character (mutation-checked: removing the mount from the dahab header turns it red). The Orders PWA has no product picker (its only search is the order-list box, abort-safe since PR 3); the product picker is the admin `orders/new` one, covered by the plan's admin PR. Cost if wrong: a future sixth template ships without suggestions until someone adds it to the test list.
