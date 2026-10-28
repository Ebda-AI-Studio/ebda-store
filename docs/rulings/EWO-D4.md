# EWO-D4

> Section: Cluster D — checkout + cart

**Ruling EWO-D4 — #2047/#2050: the delivery-window picker and submit read the same clock.**
`nowMinutes` is state refreshed every 30s and on `visibilitychange`; a picked window whose cutoff
passes is dropped with a specific "no longer available — pick another" message (both while the
page is open and at submit, which also writes its clock reading back so the picker renders the
lapse). `findStillBookableWindow` treats a today→tomorrow rollover as a lapse (ids are reused for
tomorrow, so an id match used to move a "today" booking to tomorrow silently) and a
tomorrow→today midnight crossing as the same slot. Cost if wrong: a customer idling across a
cutoff sees their slot cleared with an explanation and re-picks — never an order without the slot
they believe they booked.
