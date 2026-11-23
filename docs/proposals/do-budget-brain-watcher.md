# Proposal: brain watcher `do-budget` (for ebda-foundation / os/cloud/brain)

Daily: GraphQL `durableObjectsInvocationsAdaptiveGroups` (last 24 h, by scriptName + namespace class). projected = 30 x last24h. If projected > 1,000,000: alert once/day (dedupe key = date) naming top class + share, hourly floor, week-over-week delta, e.g. "DO projected 6.2M/mo; top ebda-api AuthState 39%, floor 2.4k/h, +12% w/w". Needs CF_ANALYTICS_TOKEN in the brain env (absent from ~/.ebda-os.local.env today). Not built in this PR: ebda-foundation is push-frozen and not a git checkout here.
