# MKT-HOME-BUDGET-1

Ruling MKT-HOME-BUDGET-1 - raise the HTML gzip budget of the Arabic home page `/` from 51.5 KB to 52.5 KB. With the dependency bumps of chore/dev-deps-audit-fix (DEP-AUDIT-2) the static export measures 52.2 KB (CI run 40923693547 reports 52.1 KB, reproduced on a local build of the branch); no marketing code changed, the framework's serialized payload grew. JS (206.3 KB), CSS and script count stay inside their budgets. Cost if wrong: the home page may grow another 0.3 KB gzip of HTML unnoticed before the gate trips again.
