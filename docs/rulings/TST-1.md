# TST-1

> Section: 2026-10-03 — scoped-audit follow-ups (branch `fix/backlog-followups11`, issues 2427, 2429-2432, 2434)

**Ruling TST-1 — the over-cap order-search fixtures are unique per attempt, not per file (issue 2427).**
CI runs the integration tier with `--retry=1`; a retry re-runs the test body against the same database
but not `beforeAll`. The over-cap case built 1,001 users and orders from the per-file `suffix`, so a
retry collided with attempt 1's rows (unique email, unique order number) and reported attempt 2's
P2002 instead of the real failure. The body now draws a per-call `run` id used in the emails, order
numbers and search term. Not swept: other integration tests that create unique-keyed rows inside a
test body; the named sibling, `product-search-floor`, creates its fixtures in `beforeAll`, which a
retry does not re-run, so it is not exposed. Cost if wrong: test-only; a dead attempt's rows are
removed by `afterAll` (users by id, orders by store).
