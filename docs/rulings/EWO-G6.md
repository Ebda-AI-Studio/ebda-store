# EWO-G6

> Section: Cluster G — product cards, error fallback, UI

**Ruling EWO-G6 — #2110's blank-string fallback is applied to product and category NAMES only, not
to page-builder section copy.** `pickLocalizedName` now covers every product/category name display
path: a product with a blank name is never intentional, and the API accepts `nameAr: ''`. The same
`xAr ?? x` idiom remains in merchant-authored section copy (`FormCard` ×5, `HeroBanner`,
`SectionHeading`, `BrandStoryBlock`, `useRtlText`, `BottomTabBar`, `MinimalChrome`,
`FloatingWidget`, `useOrderSummaryBase`, the footer copyright override). There, a blank Arabic field
can be a deliberate "show nothing in Arabic", and changing it would change what live Arabic
storefronts render. That is a look change, not a bug fix, under the batch's standing rule. Cost if
wrong: a merchant who cleared an Arabic section field by accident sees an empty heading in Arabic
instead of the English one until they fill it in.
