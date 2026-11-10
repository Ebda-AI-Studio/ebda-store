# ICEBERG-ADM-CONSENT-1

> Section: Iceberg quick wins (2026-11-10)

**Ruling ICEBERG-ADM-CONSENT-1 - the admin and orders PostHog load only after the shared first-party `ebda_consent` cookie says `analytics: true`; the banner fires `ebda:consent-change` and a later decline opts capture out; no consent = no import, no request.** Iceberg audit #5 (admin always-on); the orders PWA had the same always-on provider (defect class). Tests render both providers with no cookie, decline, accept and a late answer (4 of 5 fail against the old provider). The privacy policy still says PostHog runs in the dashboard (over-disclosure, now with consent); not edited because PR #520 owns marketing copy. Cost if wrong: merchants who never saw the banner (signed up before it) send no analytics, so dashboard funnels go thin until a consent prompt exists inside the admin.
