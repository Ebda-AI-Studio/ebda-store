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
      <body style={{ margin: 0, fontFamily: 'system-ui, sans-serif' }}>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: '100vh',
            padding: '1rem',
            textAlign: 'center',
          }}
        >
          <h2 style={{ fontSize: '1.5rem', fontWeight: 600, marginBottom: '0.5rem' }}>
            Admin Error
          </h2>
          <p style={{ color: '#6b7280', marginBottom: '1rem', maxWidth: '28rem' }}>
            A critical error occurred in the admin application.
          </p>
          {error.digest && (
            <p
              style={{
                fontFamily: 'monospace',
                fontSize: '0.75rem',
                color: '#6b7280',
                background: '#f3f4f6',
                padding: '0.5rem 0.75rem',
                borderRadius: '0.5rem',
                marginBottom: '1rem',
              }}
            >
              Error ID: {error.digest}
            </p>
          )}
          <p
            style={{
              fontFamily: 'monospace',
              fontSize: '0.75rem',
              color: '#6b7280',
              background: '#f3f4f6',
              padding: '0.5rem 0.75rem',
              borderRadius: '0.5rem',
              marginBottom: '2rem',
              maxWidth: '28rem',
              wordBreak: 'break-all',
            }}
          >
            {error.message || 'Unknown error'}
          </p>
          <div style={{ display: 'flex', gap: '0.75rem' }}>
            <button
              onClick={reset}
              style={{
                backgroundColor: '#ff6e00',
                color: '#fff',
                border: 'none',
                borderRadius: '0.5rem',
                padding: '0.625rem 1.5rem',
                fontSize: '0.875rem',
                fontWeight: 500,
                cursor: 'pointer',
              }}
            >
              Try Again
            </button>
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- global-error has no Next.js context */}
            <a
              href="/"
              style={{
                display: 'inline-block',
                border: '1px solid #e5e7eb',
                borderRadius: '0.5rem',
                padding: '0.625rem 1.5rem',
                fontSize: '0.875rem',
                fontWeight: 500,
                color: '#1f2937',
                textDecoration: 'none',
                cursor: 'pointer',
              }}
            >
              Go to Dashboard
            </a>
          </div>
        </div>
      </body>
    </html>
  );
}
