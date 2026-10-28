# INTRED-6

> Section: Main integration lane red (2026-10-22, branch `fix/main-integration-red`)

- Ruling INTRED-6 - `mfa`, `mcp/agent-checkout` and `self-serve-onboarding-live` failed locally only because `TEST_API_URL` defaults to `localhost:4000` and a stale API from another checkout was listening there; they pass against the lane's own API (`TEST_API_URL`). Not a code or test change.
