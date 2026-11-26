import { buttonVariants } from '@/components/ui/Button';
import { storefrontOrigin } from '@ebda/shared';

/**
 * "View in store" opens the public product page, which 404s for anything not published (drafts are never
 * public and the storefront has no owner-only product preview). So the link only exists for active products.
 */
export function ViewInStoreLink({
  storeHost,
  slug,
  status,
  label,
}: {
  storeHost: { slug: string; domain?: string | null } | null | undefined;
  slug: string;
  status: string;
  label: string;
}) {
  if (!storeHost || status !== 'active') return null;
  return (
    <a
      href={`${storefrontOrigin(storeHost)}/products/${slug}`}
      target="_blank"
      rel="noopener noreferrer"
      className={buttonVariants({ variant: 'outline' })}
    >
      {label}
    </a>
  );
}
