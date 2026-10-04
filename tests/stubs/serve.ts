/**
 * Serves one of the gateway stubs (`PaymobStub`, `KashierStub`, `FawryStub`) over a real
 * loopback HTTP socket, so a test can run the application's REAL adapter, factory and routes
 * against it (the adapter reads its base URL from `PAYMOB_BASE_URL` / `KASHIER_BASE_URL` /
 * `FAWRY_BASE_URL`). `onRequest` runs at the moment a request reaches the "gateway", before
 * it is answered, which is where a test can look at what the application is holding open
 * while it waits (an open database transaction, a pooled connection).
 */
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

export type StubFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface ServedStub {
  url: string;
  close(): Promise<void>;
}

export async function serveStub(
  handler: StubFetch,
  onRequest?: (req: { method: string; path: string }) => void | Promise<void>
): Promise<ServedStub> {
  const sockets = new Set<Socket>();
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      void (async () => {
        try {
          const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
          await onRequest?.({
            method: req.method ?? 'GET',
            path: new URL(req.url ?? '/', origin).pathname,
          });
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(req.headers)) {
            if (typeof v === 'string') headers[k] = v;
          }
          const body = Buffer.concat(chunks).toString('utf8');
          const out = await handler(`${origin}${req.url ?? '/'}`, {
            method: req.method,
            headers,
            body: body === '' ? undefined : body,
          });
          res.writeHead(out.status, { 'Content-Type': 'application/json' });
          res.end(await out.text());
        } catch {
          // A stub "unavailable" fault: the connection just drops.
          req.socket.destroy();
        }
      })();
    });
  });
  server.on('connection', s => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise<void>(resolve => {
        for (const s of sockets) s.destroy(); // a "hung" gateway leaves sockets open
        server.close(() => resolve());
      }),
  };
}
