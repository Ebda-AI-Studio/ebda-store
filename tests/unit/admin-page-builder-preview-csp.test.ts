import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The page-builder preview must be able to embed ANY merchant's storefront.
 *
 * `frame-src` governs what the admin may embed; the storefront's own
 * `frame-ancestors` governs who may embed it. Both must permit the embed, and
 * only the storefront side is a real access control — it names the admin
 * origins explicitly and is untouched by anything here.
 *
 * This broke in production: the admin's frame-src was a hand-written list of
 * merchant domains containing exactly one tenant (`wadyaljuz.com`). Every
 * merchant onboarded after that silently lost their live preview and got
 * Chrome's "This content is blocked" — Pecannbee among them, because
 * `pecannbee.com.kw` was never added. A custom domain is arbitrary and
 * unknowable at build time, so an allowlist is wrong by construction.
 */

const CONFIG = fs.readFileSync(path.resolve(process.cwd(), 'apps/admin/next.config.js'), 'utf-8');

/** The generated header sets, evaluated without Next's plugin wrapper. */
async function rules(): Promise<{ source: string; csp: string }[]> {
  const start = CONFIG.indexOf('const PREVIEW_FRAME_SRC');
  const end = CONFIG.search(/^(const nextConfig|module\.exports)/m);
  const body = CONFIG.slice(start, end);
  const make = new Function(
    `${body}
     return [
       { source: 'page-builder', csp: securityHeaders(PREVIEW_PAGE_FRAME_SRC) },
       { source: 'other', csp: securityHeaders(PREVIEW_FRAME_SRC) },
     ];`
  ) as () => { source: string; csp: { key: string; value: string }[] }[];
  return make().map(r => ({
    source: r.source,
    csp: r.csp.find(h => h.key === 'Content-Security-Policy')!.value,
  }));
}

const frameSrc = (csp: string) => (csp.match(/frame-src[^;]*/) ?? [''])[0];

describe('page-builder preview CSP', () => {
  it('lets the preview route embed an arbitrary merchant domain', async () => {
    const preview = (await rules()).find(r => r.source === 'page-builder')!;
    // Compare TOKENS, never a substring: `toContain('https:')` is satisfied by
    // `https://store.force-ai.co`, so the strict list — the original bug —
    // passed this assertion. Mutation testing caught it.
    expect(frameSrc(preview.csp).split(/\s+/)).toContain('https:');
  });

  it('keeps every other admin route on the strict list', async () => {
    const other = (await rules()).find(r => r.source === 'other')!;
    const fs_ = frameSrc(other.csp);
    expect(fs_).toContain('https://*.force-ai.co');
    // The bare scheme must NOT leak into the catch-all.
    expect(fs_.split(/\s+/)).not.toContain('https:');
  });

  it('still refuses to let the admin itself be framed', async () => {
    for (const r of await rules()) {
      expect(r.csp).toContain("frame-ancestors 'none'");
    }
  });

  it('ships no merchant domain in the allowlist — that is what broke it', async () => {
    // Asserted against the EMITTED header, not the file: the comment above the
    // constant names `wadyaljuz.com` on purpose, to record why a hand-kept
    // list was the wrong shape. Forbidding the string anywhere would delete
    // the explanation along with the bug.
    for (const r of await rules()) {
      expect(frameSrc(r.csp)).not.toContain('wadyaljuz');
      expect(frameSrc(r.csp)).not.toContain('pecannbee');
    }
  });

  it('applies the same header set to both routes', async () => {
    const start = CONFIG.indexOf('const PREVIEW_FRAME_SRC');
    const end = CONFIG.search(/^(const nextConfig|module\.exports)/m);
    const make = new Function(
      `${CONFIG.slice(start, end)}
       return [securityHeaders('https:'), securityHeaders(PREVIEW_FRAME_SRC)];`
    ) as () => { key: string }[][];
    const [a, b] = make();
    expect(a.map(h => h.key)).toEqual(b.map(h => h.key));
    expect(a.map(h => h.key)).toContain('Strict-Transport-Security');
  });
});
