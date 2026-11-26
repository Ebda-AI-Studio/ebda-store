/**
 * vitest globalSetup: generate the build-time assistant assets (apps/api/src/smart-layer/registry.generated.json and
 * apps/api/src/cf/modules/help-corpus.mjs) before any test imports them. They are git-ignored, so a fresh clone or a worktree has none.
 * The generator writes only what changed, so a watcher never sees a rewrite. docs/plans/2026-11-24-help-corpus-build-time.md.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../apps/api/scripts/build-help-corpus.mjs', import.meta.url));

export default function setup(): void {
  execFileSync(process.execPath, [SCRIPT], { stdio: 'inherit' });
}
