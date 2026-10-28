# EWO-F5

> Section: Cluster F — agent discovery, llms.txt, SEO, i18n

**Ruling EWO-F5 — #2196: JSON-LD names follow the page locale on the PDP (both trees), the bundle
detail page and the Organization block; listing-page breadcrumbs/ItemLists are NOT changed in this
batch.** `localizedField` + `BREADCRUMB_LABELS` in `lib/structured-data.ts` are the shared helpers;
under `ar` a Product/Bundle `description` is the Arabic one or omitted (the metadata's own rule),
never English. The Home / PLP / Categories / About / Contact / FAQ / Bundles-index pages still emit
English breadcrumb labels and `name: p.name` in their ItemLists — those pages' own `<title>`s were
not localized by #1987, so there is no same-page contradiction to fix there yet. Cost if wrong: an
Arabic listing page's breadcrumb rich result reads "Home › Products" — follow-up is to thread the
same locale through those bodies with these helpers.
