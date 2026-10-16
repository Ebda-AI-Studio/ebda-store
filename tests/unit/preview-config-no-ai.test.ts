/**
 * PR3 final review minor 1 (Ruling SEARCH-T10-6): the preview API Worker gets NO Workers AI binding.
 * Preview has no Inngest keys (the indexer never runs there) and no semantic flag, so the binding
 * has no use — and with it, any embed on preview would bill the production (Whisky) account.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { it, expect } from 'vitest';

const OUT = 'apps/api/.wrangler.preview.jsonc';

it('scripts/preview/preview-config.mjs api writes a config without the ai binding', () => {
  const before = existsSync(OUT) ? readFileSync(OUT, 'utf8') : null;
  try {
    const r = spawnSync(process.execPath, ['scripts/preview/preview-config.mjs', 'api'], {
      env: { ...process.env, PREVIEW_HYPERDRIVE_ID: 'a'.repeat(32), PREVIEW_KV_ID: 'b'.repeat(32) },
      encoding: 'utf8',
    });
    expect(r.status, r.stderr).toBe(0);
    const cfg = JSON.parse(readFileSync(OUT, 'utf8'));
    expect(cfg.name).toBe('ebda-api-preview');
    expect(cfg).not.toHaveProperty('ai');
    expect(cfg.vars.SEARCH_SEMANTIC_ENABLED).toBe('false');
    // The base config still has it (production keeps the binding).
    expect(readFileSync('apps/api/wrangler.jsonc', 'utf8')).toMatch(
      /"ai":\s*\{\s*"binding":\s*"AI"/
    );
  } finally {
    if (before === null) rmSync(OUT, { force: true });
    else writeFileSync(OUT, before);
  }
});
