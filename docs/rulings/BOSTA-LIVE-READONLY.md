# BOSTA-LIVE-READONLY

> Section: BOSTA-LIVE-READONLY (2026-10-08)

Ruling BOSTA-LIVE-READONLY — Bosta stays unverified. Evidence: Ebda's own LIVE Bosta business key: testConnection PASS (wrong key → 401), pickup locations and cities read, the calculator answered (a bundle account returns `priceAfterVat: 0` with `bundleDiscount == shippingFee`, now parsed as a real 0 quote); creating a delivery was refused with HTTP 400 "Active bundle subscription required to create orders", so the create payload (`packageType: 'Parcel'` + `size`) is still unproven. Unblock: an active Bosta bundle on that account or a Bosta staging account, then `--create`. Cost if wrong: none while Bosta shows «قريبًا»; merchants cannot enable it.
