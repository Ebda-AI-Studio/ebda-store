# EP-4

> Section: Lifecycle emails and referral attribution (2026-10-22, branch `feat/lifecycle-emails`)

Ruling EP-4 (Task 10, 2026-10-22) - the merchant's header chrome (logo position, search placement) is a theme-draft override of the look's `chrome.header`, edited in the Theme pane's Header group; precedence merchant > look > skin via `resolveHeaderChrome`. Both keys are in `LOOK_OWNED_THEME_KEYS`, so a design reset clears them and `keep` leaves them; the theme PUT accepts only the listed values. There is no "header band" override: `LookChrome` has no such key and no skin draws one. Evidence: `chrome-override.test.ts`, `header-chrome-override.test.tsx`. Cost if wrong: a Qamar or Souq merchant who set an override loses it on a `reset` switch (the look pane says what resets).
