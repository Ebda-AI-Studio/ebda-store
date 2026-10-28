# EWO-F4

> Section: Cluster F — agent discovery, llms.txt, SEO, i18n

**Ruling EWO-F4 — #2194/#2195: Arabic PWA identity ships as EXTRA manifest members (`name_ar`,
`short_name_ar`, `description_ar`) on the one API manifest, not as a `?lang=` variant.** One
`pwa:<storeId>`-tagged fetch then serves both locales, so `PWAService.updateSettings`' single tag
bust refreshes both and no cache-key contract changes; browsers ignore unknown manifest members.
`name_ar` falls back to `store.nameAr`; `description_ar` to `تسوق في <name>`. Under `ar` the
storefront never falls back to the English API description. Residual: the live custom-domain
manifest only reflects this once the middleware matcher change (a sibling fix in this batch that
stops excluding `manifest.webmanifest`) is deployed — until then custom domains serve the platform
manifest regardless. `apps/admin/src/app/manifest.ts` is admin chrome, English by design, and out
of scope. Cost if wrong: a consumer that reads the raw API manifest sees three non-standard keys.
