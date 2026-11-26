import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { erasureEnabled } from '../../apps/api/src/cf/erasure/job';

// Row 33 / M-024: Ahmad approved turning the PDPL erasure job on (2026-11-20). It is a wrangler var, NOT a dashboard var (a
// dashboard var is wiped by the next deploy), so the committed config is what decides whether closure erases or answers 503.
it('the API wrangler config sets PDPL_CF_ERASURE_ENABLED="true" so merchant closure really erases', () => {
  const src = readFileSync('apps/api/wrangler.jsonc', 'utf8');
  const m = src.match(/^\s*"PDPL_CF_ERASURE_ENABLED":\s*"([^"]*)"/m);
  expect(m?.[1]).toBe('true');
  expect(erasureEnabled({ PDPL_CF_ERASURE_ENABLED: m?.[1] })).toBe(true);
});
