# EP-2

> Section: Lifecycle emails and referral attribution (2026-10-22, branch `feat/lifecycle-emails`)

Ruling EP-2 (Task 10, 2026-10-22) - the matrix is the editor's definition of done and the baseline is empty: `editor-matrix.json` has no `no-op`, `missing` or `marker-pending` row for a built look, and the test pins both. Controls whose effect the static HTML cannot show (a timer, what the home page fetches) are judged by a named reader (`BEHAVIOUR_READERS`: file plus the exact expression), so deleting the reader still turns the row red. Cost if wrong: a reader that stays in the file but is no longer reached; the reader list is short and each entry names its expression.
