# Admin search (⌘K palette, Settings search box)

Search program P2 (Tasks 15 to 18, amendment E23). Plan: `docs/plans/done/2026-10-15-semantic-search.md`.

## What a merchant can find

| Kind                          | Where it is matched                                                                                                | Opens                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| Products                      | `GET /stores/:storeId/search` (term in the `X-Search-Query` header) → `searchProductIds` (admin scope, name field) | `/stores/:id/products/:productId/edit`                 |
| Orders                        | same route → `OrderService.listWhere` (number, digits of the number, customer name, phone, email)                  | `/stores/:id/orders/:orderId`                          |
| Customers                     | same route → `matchingCustomers`; guests are keyed by lowercased email, else phone (the Customers-page key)        | `/stores/:id/customers/:customerKey`                   |
| Pages and individual settings | the settings registry, in the browser (no request)                                                                 | the page, or the page at the control (`?setting=<id>`) |

**The term never travels in the URL** (Ruling SEARCH-P2-9): the palette, the Customers list/export and typeahead,
the Orders list/export, the stock-scan lookup and the Orders PWA send it in `X-Search-Query` (`searchQueryHeaders` /
`moveSearchToHeader` in `@ebda/shared`; read by `apps/api/src/lib/search-term.ts`). The palette route accepts no
`?q=`; the older routes still accept the deprecated query form for one release.

The palette route is rate limited per user (`adminSearchLimiter`, 120/min) and capped (50 customers, 200 guest
orders, 50 order-number ids; one customer lookup shared with the order search). A 429 or a failure is shown as its
own state, never as "no results". The Customers list says when a search hit its own cap (`meta.searchTruncated`).

The palette (`apps/admin/src/components/CommandPalette.tsx`) shows pages and settings immediately and the
three record groups after a 200 ms debounce (two characters minimum, a reply for an older query is dropped).
Each record kind is gated by its page's permission (`products:read`, `orders:read`; customers follow the
customer typeahead's `orders:read`); a kind the role may not read is an empty list.

## Customer, order and phone search in SQL (Tasks 15 to 17)

- `public.ebda_digits(text)` folds Arabic-Indic and Persian digits and drops every non-digit.
  `phoneSearchDigits` (`packages/shared/src/search/phone-search.ts`) is its TypeScript side: `+20 101 234 5678`,
  `0020…`, `01012345678`, `٠١٠…` all search the same digits.
- Four expression trigram indexes (migration `20261027000100`): `users_phone_digits_trgm_idx`,
  `users_name_norm_trgm_idx`, `orders_guest_phone_digits_trgm_idx`, `orders_guest_name_norm_trgm_idx`
  (see `docs/DB-INDEX-MIGRATIONS.md`). Names are matched through `public.ebda_ar_norm` ("احمد" finds "أحمد").
- `public.ebda_customer_search_ids` (migration `20261027000200`) is the store-scoped SECURITY DEFINER lookup that
  uses them. It is STORE-FIRST (Ruling SEARCH-P2-8): users are matched inside the store's own customer set, and the
  guest-order indexes are `btree_gin` composites leading with `store_id`, so a small store never pays for the
  platform's matches of a common name. Same contract as `ebda_order_search_ids`: the store comes only from `app.current_store_id`, ids
  only, soft-deleted rows and accounts, and users the `users` policy would hide, are excluded. As `ebda_app` the RLS barrier
  makes an inline `ILIKE` unable to use any trigram index, so every customer/order/typeahead search goes
  through it. `apps/api/src/services/admin-search.service.ts` is the only caller.
- Customers list, export and typeahead: `aggregateCustomersMatching` (list/export rows) and
  `searchOrderCustomers` (typeahead). The KPI strip stays store-wide (cached aggregate); a search replaces
  only the rows. A customer older than the 20,000-order scan window is found.
- Orders: `orderSearchWhere` takes customers and guests from the same lookup; a term made only of digits
  (`#١٢٣٤`) is also tried as the order number's digits.
- `ebda_order_search_ids` kinds `'guest'` and `'customers'` were dropped by migration
  `20261029000300_contract_unused_search_definers` (the function now answers `'order_number'` only), together
  with the 5-argument `ebda_product_embed_doc`. The per-key indexes `orders_guest_first_name /
last_name / phone_trgm_idx` and `users_first_name / last_name / phone_trgm_idx` are no longer used by the
  app either; they stay for now and are dropped by a separate contract migration.

## Pages and settings: the registry

`apps/admin/src/lib/settings-registry.ts` is the single list. Each entry: `id`, `route`, `labelKey` (a path
into the admin messages, so ar and en are written once), `access` (`staff` / `owner` / `super_admin`),
optional `feature`, optional `syn` (everyday words per language) and, for a setting, an optional `query`
(`tab=…`).

- `settings-search-index.generated.json` is the registry resolved against ar.json and en.json. The browser
  imports only that file. Regenerate with `npm run gen:settings-search -w apps/admin` after changing the
  registry or a registered label; `tests/unit/settings-registry.test.ts` fails while it is stale.
- `lib/settings-search.ts` ranks (own label, then page name, then synonyms; pages before their settings),
  folds Arabic (`normalizeArabicSearch`, optional "ال"), and hides what the viewer may not see: role, and a
  feature that is off or still loading.
- A setting is deep-linked as `/stores/:id/<route>?<tab>&setting=<id>`. The page marks the control with
  `data-setting-id="<id>"`; `SettingHighlight` (mounted once in `AdminLayout`) waits for it, opens collapsed
  `<details>`, scrolls to it, rings it for 3 s and focuses it. A tabbed page selects its tab from `?tab=`
  (Branding and WhatsApp do).

The visual editor (`/builder`) is registered too, one entry per control Tasks 1 to 10 added (fonts, text styles by area, section text style, dividers, background video, header logo and search, page settings, page switcher, look switch, history, add section). Its panels are generated from the section registry, so a deep link does not use `?setting=`; it uses the editor link:

`/stores/:id/builder?select=<sectionId|type|theme|history>&block=<blockId|type>&field=<id>&page=<kind>`

- `select` is a section id, else the first section of that type (page body, header, footer); `theme` and `history` open that start-pane tab instead. The selection drives the canvas and the tree together. `block` picks a block of the section by id or type. `page` is `product`, `collection` or `cart` (home when absent). `entryHref` writes `field=<entry id>` for `/builder` entries and the entry's `query` carries `select`, `block` and `page`.
- `field` is a registry id (`builder.fonts`, anchored `data-setting-id`) or a settings-schema field id (`typography`, marked `data-field-id` on the generated field). The editor opens Design mode when the field is a design field, waits for the control to render (the shared `locateAndHighlight`), scrolls to it, rings it and focuses it, once.
- The query string is untrusted: each value must be a plain token (`[A-Za-z0-9][A-Za-z0-9._:-]{0,79}`), an unknown id or type selects nothing, and nothing throws (`_lib/deeplink.ts`, `deeplink.test.ts`). Switching page drops `select`, `block` and `field`.
- `tests/unit/settings-registry.test.ts` pins the list of editor controls: a control added to the editor without an entry (or an entry without a control) fails it. `/builder` has its own `SETTINGS_LABEL_BASELINE` row.

### Adding an admin page or a setting

1. New page: add a `page(...)` entry (or list it in `REDIRECT_ROUTES` if it only redirects). Pick `access` the
   way the sidebar does (Finance and Settings hubs are owner-only) and the same `feature` the page gates on.
2. New control on a settings page: add `data-setting-id="<area>.<name>"` to its label or heading, add a
   `setting(...)` entry with Arabic and English everyday words, run `npm run gen:settings-search -w apps/admin`.
3. `npm test -- tests/unit/settings-registry.test.ts` must pass. It fails when a static admin route is not
   registered, an anchor is not registered (or the reverse), a label is missing in a language, the generated
   index is stale, or a settings page gained a labelled control without the reviewed baseline
   (`SETTINGS_LABEL_BASELINE`) being raised alongside a registry entry.

Limits, stated plainly: the registry covers every static admin page and the controls listed in it; it is not an
automatic index of every input. The label ratchet makes a new labelled control on a registered settings page
a failing test, but only for the page directories in `SETTINGS_LABEL_BASELINE`.

The `?setting=` value is untrusted: `SettingHighlight` acts only on an id the registry knows, and the DOM lookup escapes it with `CSS.escape` inside a try/catch.
