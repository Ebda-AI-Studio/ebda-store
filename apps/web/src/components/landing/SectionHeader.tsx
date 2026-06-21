import { cn } from '@/lib/utils';

/**
 * The one repeated section-header motif that glues the whole landing together
 * (the cohesion lesson from the Force Media reference landing): an optional
 * orange kicker, a bold white title, a centered 80×3px orange hairline, and an
 * optional muted subtitle. Every section renders this so the page reads as one
 * system instead of a stack of disjoint blocks.
 */
export function SectionHeader({
  kicker,
  title,
  subtitle,
  align = 'center',
  className,
}: {
  kicker?: string;
  title: string;
  subtitle?: string;
  align?: 'center' | 'left';
  className?: string;
}) {
  const isCenter = align === 'center';
  return (
    <div
      className={cn(
        'flex flex-col gap-3',
        isCenter ? 'items-center text-center' : 'items-start text-left',
        className
      )}
    >
      {kicker ? (
        <span className="text-xs font-semibold uppercase tracking-[0.2em] text-primary">
          {kicker}
        </span>
      ) : null}
      <h2 className="text-3xl md:text-5xl font-bold tracking-tight text-white">{title}</h2>
      {/* Signature orange hairline — the repeated visual constant. */}
      <span className={cn('h-[3px] w-20 rounded-full bg-primary', isCenter ? 'mx-auto' : '')} />
      {subtitle ? (
        <p className="mt-1 max-w-2xl text-base md:text-lg text-muted-foreground leading-relaxed">
          {subtitle}
        </p>
      ) : null}
    </div>
  );
}
