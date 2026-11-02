/**
 * Ruling WEB-MW-DUP-2: the ONE middleware implementation is `apps/web/middleware.ts`. Next.js looks for the file in
 * `src/` when the App Router lives in `src/app`, and in the app root otherwise, so BOTH locations must exist and both
 * must run the same code. This file is only the re-export; never put logic here.
 * `config` must be a literal in the file Next reads (a re-exported `config` is not analysable), so it is repeated
 * and `tests/unit/web-middleware-single-source.test.ts` fails if it ever differs from the root file's.
 */
export { middleware } from '../middleware';

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|sw\\.js|api/|public/|\\.well-known/security\\.txt).*)',
  ],
};
