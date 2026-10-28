# EWO-G5

> Section: Cluster G — product cards, error fallback, UI

**Ruling EWO-G5 — #2130: the retry button re-enables after 8s (`RETRY_MAX_BUSY_MS`) and the next
click hard-reloads the current url.** A second soft refresh would queue behind the hung one; a
reload stays on the merchant's host, so SR-7 is untouched. Cost if wrong: a refresh that was merely
slow (>8s) gets superseded by a full reload — one extra page load.
