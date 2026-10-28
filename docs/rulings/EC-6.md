# EC-6

> Section: 2026-09-25

**Ruling EC-6 — the legacy newsletter broadcast was fixed for the address leak but NOT migrated
onto campaigns.** It sent each 50-address chunk as one email with all 50 in `to:`, disclosing every
subscriber to every other; it now sends 50 separate emails per Resend batch call (same call count).
It still sends inline, has no unsubscribe link and no cap. Retiring it changes a live merchant
surface on 3 stores and is outside this change. Cost if wrong: until it is retired or gated behind
campaigns, a broadcast is an unsubscribable, uncapped bulk send through the platform sender —
recommended follow-up: hide the broadcast button once `email_campaigns` is on for a store.
