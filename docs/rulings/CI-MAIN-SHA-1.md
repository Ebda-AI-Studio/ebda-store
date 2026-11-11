# CI-MAIN-SHA-1

> Section: 2026-11-11 CI fast, parallel, never flaky

Ruling CI-MAIN-SHA-1 - main-push CI runs use a concurrency group per merge sha with `cancel-in-progress` off, so the latest main run always completes. Evidence: `gh run list --branch main --workflow ci.yml` showed 4 consecutive main runs `cancelled` (30f7bf0c, 17020cec, c3caca3d, e17f8a43) behind the shared `main-push` group while merges were frequent. Cost if wrong: during a merge burst several full lanes run concurrently and use more of the 50k Actions minutes/month; mitigation is the shard count and that PR CI already gates each merge.
