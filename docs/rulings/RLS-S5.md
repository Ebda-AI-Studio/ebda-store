# RLS-S5

> Section: 2026-09-25 — RLS strict policies (cutover attempt #1 rollback)

**Ruling RLS-S5 — accepted residual: the parity gate covers public/storefront endpoints only.**
Admin routes, Inngest jobs and crons are covered by the the earlier app role integration suite and the new
registry/inheritance tests, not by an owner-vs-the earlier app role payload diff. Cost if wrong: an admin or
background path that returns fewer rows (not an error) under the earlier app role is found in the staging soak
or in production instead of CI.
