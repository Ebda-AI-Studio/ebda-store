# Lens pack: builder/SaaS production failure modes (2026-08)

21 lenses distilled from reels by @-MM (`#vibecoding #aidirectedengineering`). Each is a
single claim about how AI-built production systems fail, expressed as a check any repo
can be run against.

**How to use:** run the checks against a target repo, then **read the code behind every
hit before recording a finding**. These checks are deliberately noisy — they are meant to
locate candidates, not to judge. Two candidates were discarded on inspection during the
first run (see `../2026-08-31-reel-derived-lenses.md`), and a count reported as a finding
without reading the code is how an audit manufactures false accusations.

Applied to: `force-website-builder` (2026-08-31). Not yet applied to: `gcc-horse-market`,
`Force-Media-CRM`, `whatsapp-broadcaster`, `force-merchant-intel`, the menu/landing repos.

---

## Security

**L1 — Third-party scripts run with your privileges.** A chat widget script tag reads
every form field, keystroke, cookie and session token on every page it loads on.
→ Is a CSP set? Are third-party scripts excluded from login / checkout / admin routes?
`grep -rn "Content-Security-Policy\|contentSecurityPolicy" apps` ·
`grep -rniE '<script[^>]+src="https?://' --include='*.tsx' apps`

**L3 — Admin routes with no authentication.** "Only I know the URL" is not access
control; scanners find `/admin` immediately.
→ Every route file must carry `authenticate`, or its own explicit gate.
`for f in apps/api/src/routes/*.ts; do grep -q authenticate "$f" || echo "$f"; done`
Then read each: a token, HMAC, CSRF, or fail-closed feature gate all count.

**L7 — Prompt injection reaches your data.** A user tells the AI to ignore instructions
and dump customer records; the model treats every message the same.
→ Authorization layer between AI and data; every connection scoped to the current
user/tenant; responses filtered. `grep -rn "storeId" apps/api/src/mcp/tools/*.ts`

**L9 — A dependency exfiltrates your environment.** An npm package posts
`DATABASE_URL`/API keys to an external endpoint on every boot.
→ `npm ci` (not `install`) + `npm audit` gate + lockfile integrity + secret scanning in CI.

**L10 — CORS accepts any origin with credentials.** The browser attaches cookies
automatically; any site can act as your users.
→ Hardcoded origin allowlist; no `origin: '*'` or `origin: true` alongside
`credentials: true`. Custom customer domains must be resolved, not blanket-allowed.

**L11 — SSRF through a server-side fetch of a user-supplied URL.** Reaches the cloud
metadata service (`169.254.169.254`) from inside your network.
→ A guard that blocks private/link-local/CGNAT ranges, **and something that enforces its
use.** An unenforced guard only protects the call sites that remembered it.
`grep -rn "fetch(" apps/api/src/services apps/api/src/routes` → for each, is the URL
user-supplied?

**L13 — Unverified webhook signatures.** Anyone can POST a fake payment confirmation and
trigger fulfilment.
→ Signature verification on every inbound webhook + idempotency against replay.

**L18 — The WAF you pay for is not configured.** 14,000 credential-stuffing requests sail
through because no rules were set.
→ Rate limiting on auth endpoints specifically, bot management on high-value pages.

**L8 — VPS with the front door open.** Moving off a managed platform means inheriting
every vulnerability it hid: SSH on the default port accepting passwords, all ports open,
no unattended upgrades. _(Host lens, not repo.)_

## Mobile

**L6 — Plaintext API traffic, no certificate pinning**, tokens in plaintext on device.
**L14 — Capacitor wraps a web app but does not secure it**: API keys in localStorage;
needs native keychain, cert pinning, deep-link validation.

## Data & scale

**L4 — No indexes; every query is a full table scan.** Unnoticed until the host
throttles you. → index count vs table count; slow-query logging enabled.

**L16 — One client's custom column slows every tenant by 40%.** → per-tenant schema
extensions or JSON config, never a shared-schema column for one customer.

**L19 — A repo fork per client.** Eleven branches, eleven deployments, eleven sets of
bugs. → feature flags per tenant, configuration inheritance, tenant-aware routing at the
boundary. One codebase.

**L21 — Read-after-write across replicas.** Two versions of every record; users shown the
stale one. → read-after-write routing, replica lag monitoring, conflict resolution.

## API contract

**L15 — No versioning, no deprecation policy, no request signing.** A forged request is
processed with no questions asked; consumers get no warning when an endpoint retires.
→ version prefix, `Sunset` + `Deprecation` headers, deprecation monitoring.

## Reliability

**L20 — "Operational" status page while customers screenshot errors.** → a defined error
budget per endpoint, burn-rate alerting that catches trends before outages, business cost
attribution per incident. "99.9% is not a badge, it is a budget."

## Process / AI-OS

**L2 — Stale skills anchored to dead models.** Skills written for a model that has been
updated dozens of times since compete for attention with your current instruction.
→ Treat skills as **prescriptions, not assets: apply, verify, dispose.** Audit installed
skills on a cadence; record a review date at install time.

**L5 — The same AI builds and reviews its own work.** The shortcuts that created the
vulnerability are the ones that miss it in review.
→ Route review to a _different_ vendor, framed adversarially; rotate which builds and
which breaks.

## Business

**L12 — Solve problems people already pay for.** A bakery paying 22% delivery fees could
lease a vehicle, hire a driver and commission an app for less. The math is the pitch, and
the operator owns the asset.

**L17 — Every yes is retention; every yes is debt.** After 18 months of yes the product
cannot ship without breaking. → customization cost model before the first line of code,
configuration over code branches, a productization threshold when the third client asks
for the same thing.
