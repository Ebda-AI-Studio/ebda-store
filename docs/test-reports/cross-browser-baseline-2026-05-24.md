# Cross-browser Playwright baseline — FWB — 2026-05-24

Browsers: Chromium (Desktop Chrome), Firefox (Desktop Firefox), WebKit (Desktop Safari), Mobile Safari (iPhone 14)
Run against: production (`wadyaljuz.com` storefront + `app.forcemediakw.com` admin)

## Results

### Storefront (wadyaljuz.com)

| Test                                            | Chromium | Firefox | WebKit | Mobile Safari | Notes    |
| ----------------------------------------------- | -------- | ------- | ------ | ------------- | -------- |
| home page loads with no critical console errors | ✓        | ✓       | ✓      | ✓             | All pass |
| clicking a product card navigates to a PDP      | ✓        | ✓       | ✓      | ✓             | All pass |
| cart page is reachable and renders shell        | ✓        | ✓       | ✓      | ✓             | All pass |

**Storefront totals: 3/3 Chromium · 3/3 Firefox · 3/3 WebKit · 3/3 Mobile Safari**

### Admin (app.forcemediakw.com)

| Test                                                   | Chromium | Firefox | WebKit | Notes    |
| ------------------------------------------------------ | -------- | ------- | ------ | -------- |
| login page renders with email + password inputs        | ✓        | ✓       | ✓      | All pass |
| dashboard redirects unauthenticated visitors to /login | ✓        | ✓       | ✓      | All pass |

Note: Mobile Safari project is storefront-only (admin is not a mobile-primary surface).

**Admin totals: 2/2 Chromium · 2/2 Firefox · 2/2 WebKit**

## Per-browser failures

None. All 18 test runs passed (12 storefront × 4 browsers + 6 admin × 3 browsers, minus 6 admin mobile-safari which are scoped to storefront only = 18 total).

## Firefox-specific failures

None.

## WebKit-specific failures

None.

## Mobile Safari-specific failures

None.

## Notes

- Smoke suite tests only public-facing pages that don't require auth (home, PDP, cart shell, login redirect).
- Authenticated admin flows are not covered by this suite.
- Cross-browser regressions will surface if layout/JS changes break non-Chromium engines — the baseline run confirms the current prod is clean.
