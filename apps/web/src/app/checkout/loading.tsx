export default function Loading() {
  return (
    <main className="min-h-screen bg-background">
      <nav className="border-b bg-background">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
          <div className="h-8 w-24 animate-pulse rounded bg-muted" />
          <div className="h-4 w-32 animate-pulse rounded bg-muted" />
        </div>
      </nav>
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="mb-8 flex justify-center">
          <div className="h-8 w-64 animate-pulse rounded bg-muted" />
        </div>
        <div className="lg:grid lg:grid-cols-12 lg:gap-8">
          <div className="lg:col-span-7">
            <div className="animate-pulse space-y-4 rounded-xl border bg-card p-6">
              <div className="h-6 w-48 rounded bg-muted" />
              <div className="space-y-3">
                <div className="h-10 rounded bg-muted" />
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="h-10 rounded bg-muted" />
                  <div className="h-10 rounded bg-muted" />
                </div>
                <div className="h-10 rounded bg-muted" />
                <div className="h-10 rounded bg-muted" />
                <div className="h-10 rounded bg-muted" />
              </div>
            </div>
          </div>
          <div className="mt-8 lg:col-span-5 lg:mt-0">
            <div className="animate-pulse space-y-4 rounded-xl border bg-card p-6">
              <div className="h-6 w-36 rounded bg-muted" />
              <div className="h-20 rounded bg-muted" />
              <div className="h-20 rounded bg-muted" />
              <div className="border-t pt-4">
                <div className="h-6 w-full rounded bg-muted" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
