import { describe, expect, it, vi } from 'vitest';

const { redirect } = vi.hoisted(() => ({
  redirect: vi.fn((to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`);
  }),
}));
vi.mock('next/navigation', () => ({ redirect }));

import StoreTemplateRedirectPage from './page';

describe('/template (UX:T-1)', () => {
  it('redirects to the editor, which holds the look switcher', async () => {
    await expect(
      StoreTemplateRedirectPage({ params: Promise.resolve({ id: 'store-1' }) })
    ).rejects.toThrow('NEXT_REDIRECT:/stores/store-1/builder');
  });
});
