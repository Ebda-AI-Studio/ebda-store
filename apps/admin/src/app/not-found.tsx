import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-4">
      <div className="force-card max-w-lg w-full py-12 text-center">
        <p className="mb-2 text-6xl font-bold text-primary">404</p>
        <h2 className="mb-2 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mb-8 text-muted-foreground">
          The admin page you are looking for does not exist or has been moved.
        </p>
        <Link
          href="/"
          className="rounded-lg bg-primary px-5 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          Go to Dashboard
        </Link>
      </div>
    </div>
  );
}
