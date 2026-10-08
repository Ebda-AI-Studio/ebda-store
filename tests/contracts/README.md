# Provider contract fixtures

Request / response / webhook examples copied from each provider's OFFICIAL documentation
(fetched 2026-10-07; URLs in `docs/RULINGS.md` PROVIDERS-5 and in the tests that load them).
They are the documented shapes, not recordings of a real sandbox: personal-looking sample values
in the docs (emails, phone numbers, card tokens) were replaced with `example.com` / `+2010000000xx` placeholders;
every other value is as published. `sandbox-run-*.json` files, when present, are written by
`scripts/provider-sandbox-check.mjs` from a real sandbox run (ids and amounts only).
