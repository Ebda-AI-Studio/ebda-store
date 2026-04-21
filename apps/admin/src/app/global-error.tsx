'use client';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body className="m-0 font-sans">
        <div className="flex min-h-screen flex-col items-center justify-center p-4 text-center">
          <h2 className="mb-2 text-2xl font-semibold">Admin Error</h2>
          <p className="mb-4 max-w-md text-muted-foreground">
            A critical error occurred in the admin application.
          </p>
          {error.digest && (
            <p className="mb-4 rounded-lg bg-muted px-3 py-2 font-mono text-xs text-muted-foreground">
              Error ID: {error.digest}
            </p>
          )}
          <p className="mb-8 max-w-md break-all rounded-lg bg-muted px-3 py-2 font-mono text-xs text-muted-foreground">
            {error.message || 'Unknown error'}
          </p>
          <div className="flex gap-3">
            <button
              onClick={reset}
              className="cursor-pointer rounded-lg border-none bg-primary px-6 py-2.5 text-sm font-medium text-white hover:bg-primary/90"
            >
              Try Again
            </button>
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- global-error has no Next.js context */}
            <a
              href="/"
              className="inline-block rounded-lg border border-border px-6 py-2.5 text-sm font-medium text-foreground no-underline hover:bg-muted"
            >
              Go to Dashboard
            </a>
          </div>
        </div>
      </body>
    </html>
  );
}
