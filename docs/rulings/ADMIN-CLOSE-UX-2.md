# ADMIN-CLOSE-UX-2

> Section: Admin audit closure 2026-11-09, UX track (branch `fix/admin-audit-closure`)

Ruling ADMIN-CLOSE-UX-2 - UX:TX-1 stays open: the tax time zone card stays on the tax page. Moving it means the language/store settings page owns a field the tax engine reads (VAT day boundaries); the earlier fix pass deliberately kept it (commit "keep the tax time zone card") because the tax page is where a wrong zone is noticed. No second save was added. Cost if wrong: the merchant sees one extra card and one extra Save on the tax page.
