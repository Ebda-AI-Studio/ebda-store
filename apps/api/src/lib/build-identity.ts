/**
 * Which build is actually running.
 *
 * "Merged and green" is not "live", and until this existed there was no way to
 * tell the two apart from outside: `/health` answered `{status, timestamp}`, so
 * a container still serving the previous release looked exactly like one
 * serving the new one. The deploy workflow made that worse from the other side
 * — it reports success while skipping when its token is unset, and even when it
 * does deploy it verified only that the URL returned 200, which the OLD
 * container does too.
 *
 * So the answer has to come from the process itself. These fields are
 * best-effort by nature — nothing here can force a platform to tell us what it
 * built — and the honest response to not knowing is `null`, never a guess. A
 * caller can then distinguish "this build is X" from "this build will not say",
 * which is exactly the distinction that was missing.
 */

/**
 * The commit this build was made from, or null when the build was not told.
 *
 * `BUILD_COMMIT_SHA` is baked by Dockerfile.api from a build arg, so it is set
 * whenever the image is built by something that knows the commit.
 * `RAILWAY_GIT_COMMIT_SHA` is Railway's own name for the same thing, and on
 * 2026-09-03 it turned out to be the one actually doing the work: the first
 * deploy carrying this endpoint reported the correct commit with no build arg
 * supplied and no service variable set, so Railway injects it at runtime.
 *
 * It is worth recording HOW that stayed hidden. The variable appears in neither
 * listing: not in the 85 the CLI reports, and not in the 8 the dashboard shows
 * as "added by Railway". Both describe what is CONFIGURED on the service; the
 * container's actual environment is a third thing that neither one shows, and
 * only a running process can report it. A null here still means unknown rather
 * than not-deployed.
 */
export function buildCommitSha(env: NodeJS.ProcessEnv = process.env): string | null {
  return nonEmpty(env.BUILD_COMMIT_SHA) ?? nonEmpty(env.RAILWAY_GIT_COMMIT_SHA) ?? null;
}

/**
 * The platform's id for this deployment, or null.
 *
 * Confirmed present at RUNTIME on 2026-09-03 — the first deploy carrying this
 * endpoint reported a non-null id — which also clears the Inngest deploy sync
 * that reads the same variable through a fallback chain. Until that deploy the
 * claim rested on that chain working, which it could not have proven: a chain
 * that falls through to a later term looks identical from outside.
 *
 * Like the commit, it appears in neither the CLI's variable list nor the
 * dashboard's "added by Railway" section. Absence from those is not absence
 * from the container.
 */
export function deploymentId(env: NodeJS.ProcessEnv = process.env): string | null {
  return nonEmpty(env.RAILWAY_DEPLOYMENT_ID) ?? null;
}

export interface BuildIdentity {
  commit: string | null;
  deploymentId: string | null;
}

export function buildIdentity(env: NodeJS.ProcessEnv = process.env): BuildIdentity {
  return { commit: buildCommitSha(env), deploymentId: deploymentId(env) };
}

/** A variable set to the empty string carries no more information than an unset one. */
function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
