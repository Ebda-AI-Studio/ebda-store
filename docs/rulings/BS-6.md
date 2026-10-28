# BS-6

> Section: 2026-10-01 — backlog batch b-services (branch `fix/backlog-b-services`)

**Ruling BS-6 — issues 1960 / 2173: Meta CAPI posts form-encoded (`data` JSON string +
`access_token` field) and every Meta / TikTok failure raises a P1; the live endpoint was NOT
exercised from this branch.** Form-encoding is the transport Meta's CAPI documentation shows and the
one `meta-provisioner.service.ts` already uses against Graph successfully; a token inside a JSON body
is undocumented. No merchant pixel token is available to a batch agent (and prod is off-limits), so
the proof is the outcome measurement instead: a non-2xx, an `events_received` other than 1, or a
TikTok `code` other than 0 now alerts (`pixels-capi.meta` / `pixels-capi.tiktok`) on the first real
order. What would settle it before that: send one Purchase with a `test_event_code` from a pixel's
Events Manager → Test Events. Cost if wrong: if Graph also rejects the form shape, server-side
conversions stay broken until the first alert — now minutes, not months.
