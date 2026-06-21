/**
 * shadcn-style `cn` shim for `@/lib/utils`.
 *
 * 21st.dev / shadcn components import `cn` from `@/lib/utils`. The storefront's
 * canonical class-merge helper lives in `@force/ui` (clsx + tailwind-merge) —
 * re-export it here so dropped-in components resolve without a second copy.
 */
export { cn } from '@force/ui';
