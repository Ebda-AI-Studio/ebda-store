// @vitest-environment jsdom
/**
 * Audit 2026-11-03 #7: the blog index is rendered on the server. The HTML of the first response
 * carries the posts (no "بنحمّل…" loading paragraph, no client fetch), a disabled blog and an empty
 * blog are rendered states, and a transient API failure throws instead of caching a false empty list.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('../../apps/web/src/lib/api', () => ({ API_URL: 'https://api.test' }));
const { fetchBlogPosts } = await import('../../apps/web/src/app/blog/BlogIndexBody');

const WEB = join(__dirname, '../../apps/web/src/app');
afterEach(() => vi.unstubAllGlobals());

const reply = (status: number, body: unknown) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status }))
  );

describe('fetchBlogPosts', () => {
  it('returns the published posts', async () => {
    reply(200, { data: { posts: [{ id: '1', slug: 'a', title: 'A', createdAt: 'x' }] } });
    const r = await fetchBlogPosts('s1');
    expect(r.disabled).toBe(false);
    expect(r.posts).toHaveLength(1);
  });
  it('a store with the blog off is a rendered "not available" state, not an error', async () => {
    reply(404, { success: false, error: { code: 'BLOG_DISABLED' } });
    expect(await fetchBlogPosts('s1')).toEqual({ posts: [], disabled: true });
  });
  it('a 5xx throws so the page 500s instead of caching an empty list', async () => {
    reply(503, {});
    await expect(fetchBlogPosts('s1')).rejects.toThrow(/503/);
  });
  it('the demo store makes no request', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    expect(await fetchBlogPosts('demo')).toEqual({ posts: [], disabled: false });
    expect(f).not.toHaveBeenCalled();
  });
});

describe('the blog index has no client-side first paint', () => {
  const client = readFileSync(join(WEB, 'blog/BlogIndexClient.tsx'), 'utf8');
  it('the client leaf neither fetches nor shows a loading state', () => {
    expect(client).not.toMatch(/useEffect|useState|api\.listBlogPosts|بنحمّل|Loading/);
  });
  it('both routes are server components over the same body (header + tenant param)', () => {
    for (const f of ['blog/page.tsx', 'tenant-store/[tenant]/[locale]/blog/page.tsx']) {
      const src = readFileSync(join(WEB, f), 'utf8');
      expect(src, f).not.toMatch(/^'use client'/m);
      expect(src, f).toContain('BlogIndexBody');
      expect(src, f).toContain('generateMetadata');
    }
  });
  it('the post pages stay server-rendered with Article JSON-LD', () => {
    const src = readFileSync(join(WEB, 'blog/[slug]/BlogPostBody.tsx'), 'utf8');
    expect(src).not.toMatch(/^'use client'/m);
    expect(src).toContain('BlogPosting');
  });
});
