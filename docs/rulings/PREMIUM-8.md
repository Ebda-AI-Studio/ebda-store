# PREMIUM-8

> Section: 2026-11-03 - Storefront premium defaults (PREMIUM-\*)

Ruling PREMIUM-8 - empty states share one kit (`components/EmptyStateKit.tsx`), modelled on the store 404: title, one calm line, a way out (browse all, surprise me, this store's top categories). Used by the guest wishlist, the empty wishlist and search with no results; every 'not signed in' answer code (`GUEST_CODES`) is the signed-out state, not an error. Cost if wrong: a store with no categories shows only the two buttons.
