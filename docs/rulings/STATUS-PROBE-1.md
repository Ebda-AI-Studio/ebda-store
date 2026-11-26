# Ruling STATUS-PROBE-1 - the status page reflects what a shopper feels (2026-11-17)

Evidence: #814 raised the status probe's deadline from 8 s to 15 s and counted every answer inside it as a fully available check. Storefront daily availability went from 92-98.8 % (Nov 09-15) to 100 % (Nov 16-17) while `/store/resolve` still took 3-8 s on a cache miss (p90 5.07 s, max 8.2 s, Logpush 2026-11-15): the page got greener without visitors getting faster.

Decision (apps/status):

- 15 s stays the hard abort: no answer by then is a failure (DOWN).
- An answer slower than 8 s (`SLOW_THRESHOLD_MS`) is DEGRADED, never pages by itself, two in a row still open an incident, and it NO LONGER counts as an available check in the daily rollup (`daily.ok`), so the 90-day and daily figures drop when shoppers wait that long.
- An answer between 3 s (`DEGRADED_LABEL_MS`) and 8 s is labelled "slower than usual" next to the response time, in both languages, and still counts as available.
- History stays honest: no past day is rewritten; days before this change keep the counting they were recorded with.

Not done here: an "uptime since launch / since monitor start" figure next to the 90-day one (the pre-launch admin/orders outage days of Oct 28-30 still drag the 90-day number).

Cost if wrong: the published uptime reads lower than before for the same behaviour until the miss path is fast (the parallel fill, #902, and the stale-while-revalidate change aim at that); a probe that is slow by network noise counts against uptime.
