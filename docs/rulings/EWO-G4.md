# EWO-G4

> Section: Cluster G — product cards, error fallback, UI

**Ruling EWO-G4 — #2129: only `token:primary|secondary|accent|card|muted` get a paired foreground;
a raw hex keeps white.** The paired var is a contrast decision the platform already made
(`deriveBrandRoles`); for an arbitrary hex it would be a new design decision that flips live cards.
Cost if wrong: a merchant who picks a pale RAW hex still gets white text on it.
