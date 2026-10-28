# EWO-D2

> Section: Cluster D — checkout + cart

**Ruling EWO-D2 — #2116/#2117: an unavailable (deleted-product) line is announced on /checkout and
enforced on /cart; closes R3-4's residual.** /cart's two checkout CTAs (theme `CartSummary` via the
existing `ctaDisabled`/`ctaBlockedMessage` props, which all five themes already honour, and the
default list) now gate on `belowMinimumOrder || hasUnavailableLines`. /checkout derives the notice
from the UNFILTERED cart lines: a banner with a link to /cart above the form, a `handleSubmit`
guard that shows the same copy instead of advancing, and — when every loose line is unavailable
and there are no bundles — a dedicated "Nothing in your cart can be ordered" state checked BEFORE
the generic "Your cart is empty" screen, which was false for that cart. The summary still excludes
the lines from its arithmetic (R3-4). Cost if wrong: a shopper who ignores both notices is stopped
client-side one step earlier than the server would have stopped them — the same outcome, sooner.
