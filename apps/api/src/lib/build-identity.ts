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
 * `RAILWAY_GIT_COMMIT_SHA` is Railway's own name for the same thing; it is read
 * opportunistically and is NOT verified to be present on this project's
 * service — treat a null here as "unknown", not as "not deployed".
 */
export function buildCommitSha(env: NodeJS.ProcessEnv = process.env): string | null {
  return nonEmpty(env.BUILD_COMMIT_SHA) ?? nonEmpty(env.RAILWAY_GIT_COMMIT_SHA) ?? null;
}

/**
 * The platform's id for this deployment, or null.
 *
 * NOT confirmed present, and an earlier version of this comment said it was.
 * The evidence for that claim was the Inngest client reading it to key its
 * deploy sync — but that read is a fallback CHAIN, so it could have been
 * falling through to a later term all along and nobody would have noticed.
 * Checked in the Railway dashboard on 2026-09-03: the platform adds exactly
 * eight variables to this service and this is not among them.
 *
 * It is still read, because a variable absent from the dashboard's list can
 * still be injected into the container at runtime — the list describes what
 * Railway ADDS to the service, which is not the same question. This field is
 * what will settle it: the first deploy that reports a non-null id proves the
 * injection, and a null one proves the Inngest deploy sync has been falling
 * through and needs its own fix.
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
