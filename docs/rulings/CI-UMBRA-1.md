# CI-UMBRA-1

> Section: 2026-10-07 — Ebda Store merchant app moves to store.ebda.app; admin.ebda.app retired (branch `chore/store-host`)

Ruling CI-UMBRA-1 — Ebda CI/deploy jobs run on the Umbra org runner (`umbra-ebda-1`, labels self-hosted+umbra-ebda) when repo variable EBDA_RUNS_ON is set; unset = GitHub-hosted ubuntu-latest. Evidence: Whisky-11 free plan exhausted 2000 Actions minutes (Oct 2026, billing block); Ahmad: "use umbra". Cost if wrong: if the Umbra guest dies, every Ebda job queues until the variable is deleted (`gh variable delete EBDA_RUNS_ON -R Whisky-11/ebda`).
