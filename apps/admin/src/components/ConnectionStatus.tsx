/**
 * Inline status indicator shown next to each carrier's "Test Connection"
 * button: idle (hidden), testing (spinner), success (green check),
 * error (red x).
 */
export function ConnectionStatus({ status }: { status: 'idle' | 'testing' | 'success' | 'error' }) {
  if (status === 'idle') return null;
  if (status === 'testing') {
    return (
      <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <span className="animate-spin inline-block h-3 w-3 border-2 border-current border-t-transparent rounded-full" />
        Testing…
      </span>
    );
  }
  if (status === 'success') {
    return (
      <span className="flex items-center gap-1.5 text-sm text-success">
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
        Connected
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5 text-sm text-destructive">
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M6 18L18 6M6 6l12 12"
        />
      </svg>
      Failed
    </span>
  );
}
