# PR65-PRODUCTION-DDL

> Section: BOSTA-LIVE-READONLY (2026-10-08)

Ruling PR65-PRODUCTION-DDL — prepare/test the expanded migration locally but do not apply it to production Neon without Ahmad's explicit approval, as the saved delivery plan requires. No production rows, migration checksums, or secrets are changed by this work. Cost if wrong: deploying API code before its two columns exist breaks order reads/writes.
