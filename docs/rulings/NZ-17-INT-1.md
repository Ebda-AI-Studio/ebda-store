# NZ-17-INT-1

> Section: NEON-ZERO N-17 Postgres removal, slice 1 (2026-11-05)

**Ruling NZ-17-INT-1 - the `Integration Tests` and `E2E Tests` jobs keep their Postgres service container until slice 3; they are NOT removed in slice 1.** They are the only coverage of the shared service logic (orders, stock, accounting, auth) that the Durable Object runs in production through prisma-lite, and 6 classes of assertion have no workerd equivalent yet (plan, "Replacement"). Removing the gate first would silently lose them. Cost if wrong: CI keeps spending Postgres-container minutes on a backend production no longer uses until slice 3.
