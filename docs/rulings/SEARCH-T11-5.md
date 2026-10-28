# SEARCH-T11-5

> Section: 2026-10-15 — Phase B1 Qamar (B1-\*)

Ruling SEARCH-T11-5 — `storeIndexStatus` (the viewer's numbers, Task 12): `products` = non-deleted products that HAVE text to embed (a NULL doc can never be indexed, so it is not counted as missing), `indexed` = those whose embedding is current (same model, same text hash), `stale` = the rest. A present-but-stale row is not "ready". Cost if wrong: none; display only.
