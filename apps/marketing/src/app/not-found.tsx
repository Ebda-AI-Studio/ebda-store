export default function NotFound() {
  return (
    <html lang="ar" dir="rtl" style={{ background: '#0A0B0C', color: '#F3F5F4' }}>
      <body style={{ fontFamily: 'system-ui, sans-serif', padding: 32 }}>
        <main>
          <h1>404</h1>
          <p>
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- standalone 404 shell, no router */}
            <a href="/" style={{ color: '#CBA873' }}>
              ebda.app
            </a>
          </p>
        </main>
      </body>
    </html>
  );
}
