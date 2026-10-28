# EBDA-HOST-1

> Section: 2026-10-07 — merchant admin host moves to admin.ebda.app (branch `chore/admin-host`)

Ruling EBDA-HOST-1 — admin host is admin.ebda.app (Ahmad 2026-10-07). `BRAND.domains.app` is now `BRAND.domains.admin` (`admin.ebda.app`); `app.ebda.app` is REMOVED from the API CORS allowlist, the storefront `frame-ancestors` default, the CF route generator and the platform-host parser, and stays a reserved slug with no surface (`parseStoreHost('app.ebda.app')` is `invalid`, so it 404s). Evidence: nothing was ever deployed at `app.ebda.app` (Ahmad 2026-10-07), so no live session, cookie, OneSignal origin or merchant bookmark depends on it; `api.ebda.app` CORS still accepts the admin origin via `brandUrl(BRAND.domains.admin)` plus the `ADMIN_URL` var in `apps/api/wrangler.jsonc`. Cost if wrong: if a merchant or integration was already given an `app.ebda.app` URL it now fails CORS and 404s, so re-adding it is one line in `BRAND` plus one `PLATFORM_LABELS` entry.
