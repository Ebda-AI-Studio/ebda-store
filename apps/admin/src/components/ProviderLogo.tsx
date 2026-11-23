import Image from 'next/image';
import { getProviderLogo } from '@ebda/shared';

/**
 * Provider mark for settings cards. Reuses the vendored asset from the shared logo registry;
 * a provider without one gets a neutral wordmark pill (never an imitation of a brand mark).
 * The asset sits on a light tile in BOTH themes: the marks are dark/coloured on transparent
 * and would vanish on the night surface. Local files only (CSP img-src 'self').
 */
export function ProviderLogo({
  code,
  name,
  className = '',
}: {
  code: string;
  /** Provider display name: used as alt text / wordmark text. */
  name: string;
  className?: string;
}) {
  const entry = getProviderLogo(code);
  if (entry.asset) {
    return (
      <span
        className={`inline-flex h-10 w-16 flex-shrink-0 items-center justify-center rounded-lg border border-border bg-white px-1.5 ${className}`}
        data-testid={`provider-logo-${code}`}
      >
        <Image
          src={entry.asset}
          alt={name}
          width={52}
          height={28}
          unoptimized
          className="max-h-7 w-auto max-w-full object-contain"
        />
      </span>
    );
  }
  return (
    <span
      className={`inline-flex h-10 min-w-16 max-w-28 flex-shrink-0 items-center justify-center rounded-lg border border-border bg-muted px-2 text-xs font-semibold text-foreground ${className}`}
      data-testid={`provider-logo-${code}`}
      role="img"
      aria-label={name}
    >
      <span aria-hidden="true" className="truncate">
        {name}
      </span>
    </span>
  );
}
