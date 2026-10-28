# SR-8

> Section: 2026-09-16

**Ruling SR-8 — "Try Again" now refreshes the route; two related findings are
declined with reasons.** Review found the retry button called the BARE `reset`.
Confirmed in Next's own `client/components/error-boundary.js`: the boundary
defines `reset = () => setState({error:null})` AND
`retry = () => startTransition(() => { context?.refresh(); reset(); })`, and
passes `reset` to the component — so bare `reset` re-renders the same failed
server payload. Because the transient branch suppresses "Go Home", that button
is the page's ONLY control, and a retry that cannot recover makes the page a
dead end during exactly the outage it exists to survive. Now mirrors Next's
`retry`. A headless-Chromium render of a forced transient confirms the page
itself is sound — retry body present, "Try Again" present, "Go Home" absent,
zero uncaught page errors, so the added `useRouter` hook is safe inside a
boundary. The CLICK is still not verified: proving recovery needs a browser
that flips the API back to healthy mid-session. The wiring is gated by a source
assertion in the meantime.

Declined, with reasons:

- **`global-error.tsx` keeps bare `reset`.** It renders only when the ROOT
  LAYOUT itself failed, which is the one case where the App Router context a
  `useRouter()` refresh depends on may not be mounted — Next's own boundary
  guards that call with `?.` for the same reason. Adding a hook that can throw
  to the last-resort surface trades a certain catastrophic failure for an
  uncertain recovery. Cost if wrong: a shopper on a root-layout failure must
  reload the tab manually, which is today's behaviour.
- **"Go Home" stays suppressed on custom domains too**, not just the platform
  host where the `307 → ebda.app` leak was measured. During a transient the
  API is unreachable for every route, so the merchant's home page would render
  the same retry body — the link would lead from one retry page to another
  while implying escape. "Try Again" is the honest single action on both host
  types. Cost if wrong: a custom-domain shopper loses a home link they could
  have used had the outage been route-specific rather than API-wide.
- **`StoreMaintenance.tsx:63`'s inert in-body robots meta is still only
  REPORTED** (SR-4). It is a real SEO hole — the suspended-store page returns
  HTTP 200, so unlike the retry page it has no status-code guard behind it —
  but it predates this work, belongs to the suspended-store path, and today's
  approved scope is this fix. Cost if wrong: a suspended merchant's maintenance
  page stays indexable until a one-line follow-up lands.
