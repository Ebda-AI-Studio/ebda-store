# CI-BLAST-COMMENT-1

> Section: Admin fix pass 2026-11-04, track T1 API core (branch `feat/admin-fix-t1-api-core`)

Ruling CI-BLAST-COMMENT-1 - the step caught `(URLError, KeyError, ValueError)` only. A transient network error that urllib does not wrap (a `TimeoutError` while reading the body, `ConnectionResetError`, `http.client.RemoteDisconnected`) escaped and failed an informational job once. The clause is now `except Exception`, and the warning names the exception type; the report stays in the step summary either way. Cost if wrong: a genuine bug in the comment code is reported as a warning instead of a red job.
