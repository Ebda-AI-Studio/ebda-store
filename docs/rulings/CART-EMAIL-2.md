# CART-EMAIL-2

> Section: 2026-10-16 — Search program, PR 4, Task 13 (quality eval): SEARCH-T13-\*

Ruling CART-EMAIL-2 (2026-10-21) - the email channel ships OFF and is a merchant opt-in. `abandoned_cart_configs.email_enabled` defaults false; a migration default of true would start mailing under every existing merchant's name on deploy. One reminder, delay 60..1440 min (default 120) measured from last cart activity (the abandoned-cart row already exists after 60 idle minutes, so 60 means "as soon as detected"). A reminder more than 6 h past due (channel enabled late) is skipped as `stale` instead of mailed. Cost if wrong: adoption waits for the toggle; flip the column default in a migration if Ahmad wants it on.
