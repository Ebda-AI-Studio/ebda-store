# BS-4

> Section: 2026-10-01 — backlog batch b-services (branch `fix/backlog-b-services`)

**Ruling BS-4 — issues 1989 / 1991 amend SN-4: the one retry now matches the error Prisma really
throws, and it is suspended for 5s after a read whose retry also failed; there is still no
fail-fast sentinel.** P1001/P1002 arrive as `PrismaClientInitializationError`, whose code is on
`errorCode` (verified against `@prisma/client`'s own class: `code` is undefined), so
`extractRetryCodes` reads it — SN-4's retry had been matching only a hand-built test shape. During a
sustained outage each read still makes ONE attempt (recovery is seen at once — the concern that kept
O2-2 from adding a negative cache), it just stops paying for a second. Cost if wrong: in the 5s after
an outage, one isolated connection blip that a retry would have absorbed still 500s that request.
