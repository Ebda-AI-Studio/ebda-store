# YWA-2

> Section: Backlog batch y-web-admin (2026-10-01)

**Ruling YWA-2: amends EWO-A1. A 404 from `/auth/me` carrying the API's own
`{ error: { code: 'NOT_FOUND' } }` body is `signed-out` (issue 2283).**
`authenticate` lets a validly-signed token through when its user row is gone (tokenVersion
falls back to 0 and `blocked` to false), so `AuthService.getProfile` is what answers, with 404. Admin and orders now clear the stored session on that answer, on the first read and on the
post-refresh retry. A 404 without the API envelope, such as an edge or platform page, is still
`unavailable`. That preserves EWO-A1's "mis-routed 404" case, and a test pins it. Cost if wrong:
if the API ever loses the `/auth/me` route itself, its catch-all also answers `NOT_FOUND`, and
every admin/orders session would sign out instead of waiting. That is a deploy that has already
broken login.
