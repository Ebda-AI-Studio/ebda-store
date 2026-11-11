/**
 * Vitest setup file (PREPUSH-5C, 2026-11-11): delete every GIT_* variable from process.env when a test process starts.
 *
 * WHY. Git hooks (husky pre-push, which runs unit tests) export GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE into every child.
 * A test that spawns `git init|commit|add` in a temp dir then mutates the checkout RUNNING THE HOOK instead (it committed
 * a fixture onto a real branch on 2026-11-11; the same class flipped a shared repo to core.bare=true on 2026-10-25).
 * Regex guards over test source lose whack-a-mole (aliased env, `{...process.env}`, `bash -lc`); clearing the variables at
 * the source fixes the class: any spawn, aliased or not, inherits a clean env.
 *
 * A test that needs a particular repo passes `cwd` or `git -C <dir>` explicitly (git then discovers it normally).
 * Pinned by tests/unit/vitest-git-env-scrub.test.ts (every config that runs jsdom/node tests must list this file).
 */
for (const key of Object.keys(process.env)) {
  if (key.startsWith('GIT_')) delete process.env[key];
}
