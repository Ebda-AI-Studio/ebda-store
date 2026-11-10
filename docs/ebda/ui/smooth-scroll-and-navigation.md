# Smooth scrolling and page navigation

**Rule:** a Next app whose stylesheet sets `scroll-behavior: smooth` on `html` must put
`data-scroll-behavior="smooth"` on its root `<html>`. Today that is the marketing site
(`apps/marketing/src/components/RootShell.tsx`), the storefront (`apps/web/src/app/layout.tsx`) and
the admin (`apps/admin/src/app/layout.tsx`).

**Why:** after a client navigation the Next router sets `scrollTop = 0`, then checks that the top of
the new page is in view. It only switches smooth scrolling off for that moment when the attribute is
present. Without it the reset is an animation that has not moved yet, the check fails, the router
calls `scrollIntoView()` on the page's nodes and the two animations race.

**What it looked like (ebda.app, 2026-11-10):** on a phone, opening a service page from the menu
landed at the footer (`/services/marketing/` ended at y 9071 of 9592). Direct loads were fine, and so
was the same tap from a scrolled-down page, which is why it was easy to miss.

**What stays the same:** in-page anchor links still scroll smoothly (the router leaves hash-only
changes alone), and `prefers-reduced-motion` still turns smooth scrolling off.

**Guard:** `tests/unit/smooth-scroll-route-reset.test.ts` discovers every Next app under `apps/`,
and fails when one scrolls smoothly without the attribute.

**How to check by hand:** phone-size touch browser, home page at the top, open the menu, tap a
service page. The new page must open at its top. Removing the attribute in the console
(`delete document.documentElement.dataset.scrollBehavior`) before the tap brings the bug back.
