# SR-6

> Section: 2026-09-16

**Ruling SR-6 — the `role="status"` live region is withdrawn, not restated.**
It was added to announce the boundary swap after a client-side navigation. A
live region inserted TOGETHER with its content is generally not announced by
NVDA/JAWS/VoiceOver, and wrapping the `<h2>` in one can make the heading read
as flat live-region text — so the comment claimed a benefit that probably does
not exist while carrying a real cost. The pattern that works is moving focus to
the container, which requires a real screen-reader verification this session
could not run. `aria-hidden` on the state-carrying icon is kept (that one is
unambiguous). Cost if wrong: a screen-reader user gets no announcement when the
retry page replaces a page after client-side navigation — the same behaviour as
before this work, not a regression.
