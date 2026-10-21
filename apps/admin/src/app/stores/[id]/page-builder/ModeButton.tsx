'use client';

export function ModeButton({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-xl border px-3 py-2 text-sm font-medium transition-colors cursor-pointer ${
        active
          ? 'border-primary bg-primary/10 text-primary-ink'
          : 'border-border bg-card text-foreground hover:bg-muted'
      }`}
    >
      {label}
    </button>
  );
}
