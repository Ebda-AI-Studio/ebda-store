'use client';

export default function GlobalError({
  error: _error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body className="m-0 font-sans">
        <div className="flex min-h-screen flex-col items-center justify-center p-4 text-center">
          <h2 className="mb-2 text-2xl font-semibold">Something went wrong</h2>
          <p className="mb-8 max-w-md text-muted-foreground">
            An unexpected error occurred. Please try again.
          </p>
          <button
            onClick={reset}
            className="cursor-pointer rounded-lg border-none bg-orange-500 px-6 py-2.5 text-sm font-medium text-white hover:bg-orange-600"
          >
            Try Again
          </button>
        </div>
      </body>
    </html>
  );
}
