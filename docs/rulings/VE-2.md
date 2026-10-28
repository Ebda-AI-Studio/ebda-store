# VE-2

> Section: 2026-10-22 — Visual editor (VE-\*)

Ruling VE-2 — protocol growth is additive inside `ebda-builder:v1`; child to parent requests are intents, never data. The parent re-validates each intent against the current document and registry; URLs, image keys and HTML never flow child to parent. Cost if wrong: one deploy window where canvas actions do nothing (fails closed).
