# RF-4

> Section: 2026-10-01 — Report filters apply (`fix/report-filters-apply`)

**Ruling RF-4 — the bulk product export gets no "Filters" sheet.** Its filters (status, search,
include-deleted) were verified applied on both CSV and XLSX; the file is the re-import template
shape, and an extra sheet risks the import wizard reading the wrong one. Cost if wrong: a product
export file does not say which filter produced it.
