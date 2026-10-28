# EP-7

> Section: Lifecycle emails and referral attribution (2026-10-22, branch `feat/lifecycle-emails`)

Ruling EP-7 (Task 10, 2026-10-22) - canvas markers for the shared heading row are provided by an editor-mode context (`EditorModeContext`, set only by `PageRenderer` in editor mode) rather than a prop through nine skins; the public storefront markup is unchanged. A picture's alt text carries no marker: it is written through the picture's alt prompt. Cost if wrong: a context read in a hot component; it is a single `useContext` of a boolean.
