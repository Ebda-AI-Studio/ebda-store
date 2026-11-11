/**
 * Guard (2026-10-25): a test that runs a MUTATING git command (init, commit, checkout, config, add, reset, worktree ...)
 * must do it through tests/helpers/git-env.ts. Hooks export GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE; a test that inherits
 * them mutates the checkout running the hook (it flipped the shared repo to core.bare=true and committed onto a
 * feature branch). Read-only git (ls-files, grep, diff, log, rev-parse, status, show, cat-file) against the real repo is
 * fine and is not flagged.
 *
 * Mutation-proof: the self-test section runs the detector on a bad snippet and on a good one.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '../..');
const MUTATING =
  'init|commit|checkout|switch|config|add|rm|mv|reset|clean|restore|stash|branch|tag|merge|rebase|cherry-pick|revert|am|apply|clone|fetch|pull|push|remote|worktree|update-ref|symbolic-ref|read-tree|write-tree|commit-tree|gc|prune|filter-branch|submodule';
// git invoked from JS: execFileSync('git', ['init' ...]) / spawnSync("git", ["commit"...]) / exec('git commit ...') / `git commit` in a template
const ARGV_FORM = new RegExp(
  `['"\`]git['"\`]\\s*,\\s*(?:\\[\\s*)?(?:['"\`]-[^'"\`]*['"\`]\\s*,\\s*['"\`][^'"\`]*['"\`]\\s*,\\s*)*['"\`](?:${MUTATING})['"\`]`
);
const SHELL_FORM = new RegExp(
  `(?:exec|execSync|spawn|spawnSync|execa|\\$)\\s*\\(?\\s*['"\`][^'"\`\\n]*\\bgit\\s+(?:-[A-Za-z]\\s+\\S+\\s+)*(?:${MUTATING})\\b`
);
const HELPER_IMPORT = /helpers\/git-env['"]/;
// PREPUSH-5C: git spawned with argv the guard cannot read (a spread, a variable, a helper arg list:
// `spawnSync('git', ['-c', 'user.name=t', ...a])`) cannot be proven read-only. It is allowed ONLY when the file really
// scrubs the hook-exported GIT_* env and passes the scrubbed env to THAT spawn: the code (comments stripped) must contain
// a keep-filter `!k.startsWith('GIT_')` or a `startsWith('GIT_')` ... `delete x[k]` loop, and the spawn call itself must pass an explicit env (not process.env). A comment, a single
// `delete process.env.GIT_DIR`, or an env that is not the one passed to the spawn exempts nothing. The two older checks
// above (a literal mutating verb) are NOT subject to this exemption; only tests/helpers/git-env clears those.
const SCRUB_SHAPE = new RegExp(
  [
    // keep-filter: .filter(([k]) => !k.startsWith('GIT_')) / if (!k.startsWith('GIT_')) env[k] = v
    '!\\s*\\w+\\.startsWith\\(\\s*[\'"`]GIT_[\'"`]\\s*\\)',
    // delete-loop: if (k.startsWith('GIT_')) delete e[k]
    '\\.startsWith\\(\\s*[\'"`]GIT_[\'"`]\\s*\\)[^;\\n]*\\bdelete\\s+\\w+\\s*\\[',
  ].join('|')
);
// an explicit env handed to the spawn that is not the inherited process.env: `env`, `{ cwd, env }`, `env: clean()`, `env: e`
const SPAWN_ENV = /\benv\s*(?::\s*(?!process\.env\b)[\w$]+|(?=\s*[,}]))/;
const SPAWN_GIT =
  /\b(?:execFileSync|execFile|spawnSync|spawn|execa|\$)\s*\(\s*['"`]git['"`]\s*,\s*([\s\S]{0,240})/g;
const OPT_VALUE = `(?:['"\`][^'"\`]*['"\`]|[\\w.$]+)`;
const LITERAL_VERB = new RegExp(
  `^\\[?\\s*(?:['"\`]-[cC]['"\`]\\s*,\\s*${OPT_VALUE}\\s*,\\s*)*['"\`]([a-z][a-z-]*)['"\`]`
);
const DYNAMIC_SHELL =
  /\b(?:exec|execSync|spawn|spawnSync|execa|\$)\s*\(?\s*[`'"]git\s+(?:-[A-Za-z]\s+\S+\s+)*\$\{/;
// sh -c 'git commit ...' / execSync("bash -c 'git add .'") / spawnSync('sh', ['-c', 'git commit -m x'])
const SH_C = new RegExp(
  `\\b(?:sh|bash|zsh)\\b[^\\n]{0,24}-c['"\`]?[,\\s]+\\[?\\s*['"\`][^\\n]*?\\bgit\\s+(?:-[A-Za-z]\\s+\\S+\\s+)*(?:${MUTATING})\\b`
);

const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"`])\/\/[^\n]*/g, '$1');

function dynamicGit(src: string): boolean {
  const code = stripComments(src);
  const scrubs = SCRUB_SHAPE.test(code);
  for (const m of src.matchAll(SPAWN_GIT)) {
    const v = LITERAL_VERB.exec(m[1]);
    const readOnly = v && !new RegExp(`^(?:${MUTATING})$`).test(v[1]);
    if (readOnly) continue;
    if (scrubs && SPAWN_ENV.test(stripComments(m[1]))) continue;
    return true;
  }
  return DYNAMIC_SHELL.test(src);
}

export function runsUnsanitisedMutatingGit(src: string): boolean {
  if (HELPER_IMPORT.test(src)) return false;
  return ARGV_FORM.test(src) || SHELL_FORM.test(src) || SH_C.test(src) || dynamicGit(src);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === '.git' || e === 'dist' || e === '.next' || e === '.open-next')
      continue;
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (
      /(\.test|\.spec)\.(ts|tsx|mts|mjs|js)$/.test(e) ||
      /(^|\/)tests\/.*\.(ts|mjs)$/.test(p.replace(ROOT, ''))
    )
      out.push(p);
  }
  return out;
}

describe('tests never run mutating git without the sanitised helper', () => {
  it('self-test: the detector flags the bad shapes and spares the good ones', () => {
    expect(runsUnsanitisedMutatingGit(`execFileSync('git', ['init', '-q'], { cwd })`)).toBe(true);
    expect(
      runsUnsanitisedMutatingGit(`spawnSync("git", ["-c", "user.name=t", "commit", "-qm", "x"])`)
    ).toBe(true);
    expect(runsUnsanitisedMutatingGit("execSync('git checkout -b x', { cwd })")).toBe(true);
    expect(runsUnsanitisedMutatingGit('execSync(`git config user.email a@b`)')).toBe(true);
    expect(
      runsUnsanitisedMutatingGit(
        `import { initSandboxRepo } from '../helpers/git-env';\nexecFileSync('git', ['init'])`
      )
    ).toBe(false);
    expect(
      runsUnsanitisedMutatingGit(`execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })`)
    ).toBe(false);
    expect(runsUnsanitisedMutatingGit(`execSync("git grep -l foo -- 'scripts/*.sh'")`)).toBe(false);
    expect(runsUnsanitisedMutatingGit(`const msg = 'a git commit message'`)).toBe(false);
    // PREPUSH-5C: argv the guard cannot read (spread/variable) is flagged unless the env is scrubbed
    expect(runsUnsanitisedMutatingGit(`spawnSync('git', ['-c', 'a=b', ...args], { cwd })`)).toBe(
      true
    );
    expect(runsUnsanitisedMutatingGit('execSync(`git ${args}`, { cwd })')).toBe(true);
    expect(runsUnsanitisedMutatingGit(`spawnSync('git', args, { cwd })`)).toBe(true);
    const scrub = `const clean = (x = {}) => { const e = { ...process.env, ...x }; for (const k of Object.keys(e)) if (k.startsWith('GIT_')) delete e[k]; return e; };\n`;
    // the real exemption shape: a full GIT_ scrub AND the scrubbed env passed to the git spawn
    expect(
      runsUnsanitisedMutatingGit(`${scrub}spawnSync('git', args, { cwd, env: clean() })`)
    ).toBe(false);
    // ...but the scrub defined and NOT passed to the spawn exempts nothing
    expect(runsUnsanitisedMutatingGit(`${scrub}spawnSync('git', args, { cwd })`)).toBe(true);
    // reviewer bypasses: a comment or a single delete must NOT clear the older literal-verb checks
    expect(
      runsUnsanitisedMutatingGit(`// uses test-git-env.sh\nexecFileSync('git', ['init'])`)
    ).toBe(true);
    expect(
      runsUnsanitisedMutatingGit(
        `/* startsWith('GIT_') delete e[k] */\nexecFileSync('git', ['init'])`
      )
    ).toBe(true);
    expect(
      runsUnsanitisedMutatingGit(`delete process.env.GIT_DIR;\nexecFileSync('git', ['init'])`)
    ).toBe(true);
    expect(
      runsUnsanitisedMutatingGit(`${scrub}execFileSync('git', ['init'], { env: clean() })`)
    ).toBe(true);
    expect(
      runsUnsanitisedMutatingGit(
        `// startsWith('GIT_') delete e[k]\nspawnSync('git', args, { env: x() })`
      )
    ).toBe(true);
    // read-only with -C <dir> / -c k=v stays allowed
    expect(runsUnsanitisedMutatingGit(`execFileSync('git', ['-C', dir, 'ls-files', '-z'])`)).toBe(
      false
    );
    expect(runsUnsanitisedMutatingGit(`spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'])`)).toBe(
      false
    );
    // sh -c wrappers
    expect(runsUnsanitisedMutatingGit(`execSync("sh -c 'git commit -qm x'", { cwd })`)).toBe(true);
    expect(
      runsUnsanitisedMutatingGit(`spawnSync('sh', ['-c', 'git add . && git commit -m x'])`)
    ).toBe(true);
    expect(runsUnsanitisedMutatingGit(`execSync("bash -c 'git ls-files'")`)).toBe(false);
    expect(runsUnsanitisedMutatingGit(`spawnSync('git', ['ls-files'], { cwd })`)).toBe(false);
  });

  it('the reviewer bypass (a comment + one GIT_ delete) is flagged', () => {
    const bad = readFileSync(
      join(__dirname, '__fixtures__/comment-exempt-git-init.bad.txt'),
      'utf8'
    );
    expect(runsUnsanitisedMutatingGit(bad)).toBe(true);
  });

  it('the #651 cache test (unscrubbed temp-repo git, the 2026-11-11 incident) is flagged', () => {
    const bad = readFileSync(join(__dirname, '__fixtures__/unscrubbed-git-spawn.bad.txt'), 'utf8');
    expect(runsUnsanitisedMutatingGit(bad)).toBe(true);
  });

  it('finds test files to scan (the guard is not vacuous)', () => {
    expect(walk(join(ROOT, 'tests')).length).toBeGreaterThan(200);
  });

  it('no test or test helper runs a mutating git command outside tests/helpers/git-env.ts', () => {
    const offenders: string[] = [];
    for (const dir of ['tests', 'apps', 'packages', 'scripts']) {
      for (const f of walk(join(ROOT, dir))) {
        const rel = relative(ROOT, f);
        if (
          rel === 'tests/helpers/git-env.ts' ||
          rel === 'tests/unit/no-unsanitised-git-in-tests.test.ts'
        )
          continue;
        if (runsUnsanitisedMutatingGit(readFileSync(f, 'utf8'))) offenders.push(rel);
      }
    }
    expect(
      offenders,
      'Use initSandboxRepo()/sandboxGit() from tests/helpers/git-env.ts (strips the hook-exported GIT_* env)'
    ).toEqual([]);
  });
});
