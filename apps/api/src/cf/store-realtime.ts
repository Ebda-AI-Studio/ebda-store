/**
 * StoreRealtime: admin realtime on Workers (R-EBDA-001, replaces socket.io).
 *
 * socket.io needs a long-lived Node process holding sockets and an adapter to fan out
 * between replicas. On Workers the sockets live in Durable Objects as HIBERNATING
 * WebSockets (the DO is evicted while idle; the sockets stay open and wake it on a
 * message), and fan-out is an RPC between two kinds of instance of this one class:
 *
 *   user:<userId>   terminates that user's WebSockets (one per browser tab) and speaks
 *                   the Socket.IO v4 wire protocol over a plain WebSocket, so the stock
 *                   socket.io-client works unchanged when it uses `transports:
 *                   ['websocket']` (apps/admin NotificationContext). Same event names:
 *                   `notification`, `ui-refresh`, `subscribe:store`, `unsubscribe:store`.
 *   store:<storeId> the room: the set of user DOs subscribed to the store. Express
 *                   (socket.service.ts on Workers) calls `emitStore`; it fans out to each
 *                   subscribed user DO's `deliver`.
 *
 * Authentication is NOT re-implemented here. The Socket.IO CONNECT packet carries the
 * token (`auth.token`) or the upgrade request carried the cookie; the DO asks the API's
 * own `authenticate` middleware (GET /api/v1/realtime/session, and
 * /realtime/stores/:id/access for `subscribe:store`) so JWT checks, the jti denylist,
 * token versions and store ownership are exactly the HTTP rules. A revoked token is
 * rejected at subscribe time as well.
 */
import { DurableObject } from 'cloudflare:workers';
import { fetchWithTimeout } from '../lib/fetch-timeout';

const PING_INTERVAL_MS = 25_000;
const PING_TIMEOUT_MS = 60_000;
/**
 * TEN-7 (2026-11-12 audit): membership was checked once, at `subscribe:store`. A staff member removed later kept
 * receiving that store's order events on an open socket. Before a store event reaches a socket, its membership
 * is re-checked through the same /realtime/stores/:id/access rule once the last check is older than this.
 * Staleness class BOUNDED: a removal takes effect within this window (residual: up to 30 s of events).
 */
// pq-allow(unused-export): imported by tests/unit/store-realtime-reverify.test.ts
export const REVERIFY_MS = 30_000;

interface Attachment {
  sid: string;
  /** The user this DO instance belongs to (from the upgrade); the token must be theirs. */
  expectUser: string;
  /** Set once the CONNECT packet authenticated. */
  userId?: string;
  email?: string;
  role?: string;
  token?: string;
  cookie?: string;
  subs: string[];
  /** storeId -> epoch ms of the last successful membership check (subscribe or re-check). */
  checked?: Record<string, number>;
}

interface RealtimeEnv {
  API_URL?: string;
  STORE_REALTIME: {
    idFromName(n: string): unknown;
    get(id: unknown): StoreRealtime;
  };
}

export interface DeliverArgs {
  event: string;
  payload: unknown;
  /** Only sockets subscribed to this store receive it; omitted = every socket of the user. */
  storeId?: string;
}

function sid(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 20);
}

export class StoreRealtime extends DurableObject<RealtimeEnv> {
  // ------------------------------------------------------------ user: sockets

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    const att: Attachment = {
      sid: sid(),
      expectUser: request.headers.get('x-realtime-user') ?? '',
      cookie: request.headers.get('cookie') ?? undefined,
      subs: [],
    };
    this.ctx.acceptWebSocket(server);
    (server as unknown as { serializeAttachment(v: unknown): void }).serializeAttachment(att);
    // Engine.IO OPEN packet.
    server.send(
      '0' +
        JSON.stringify({
          sid: att.sid,
          upgrades: [],
          pingInterval: PING_INTERVAL_MS,
          pingTimeout: PING_TIMEOUT_MS,
          maxPayload: 1_000_000,
        })
    );
    await this.ensurePing();
    return new Response(null, { status: 101, webSocket: client } as ResponseInit);
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    if (typeof data !== 'string') return;
    const att = this.att(ws);
    const type = data[0];
    if (type === '3') return; // pong
    if (type === '1') {
      // Engine.IO CLOSE
      ws.close(1000, 'client closed');
      return;
    }
    if (type !== '4') return; // only MESSAGE packets carry Socket.IO traffic
    const body = data.slice(1);
    const sioType = body[0];
    if (sioType === '0') return void (await this.onConnect(ws, att, body.slice(1)));
    if (sioType === '1') return void ws.close(1000, 'disconnect');
    if (sioType === '2') {
      if (!att.userId) return;
      try {
        const [event, arg] = JSON.parse(body.slice(1)) as [string, unknown];
        if (event === 'subscribe:store' && typeof arg === 'string')
          await this.subscribe(ws, att, arg);
        else if (event === 'unsubscribe:store' && typeof arg === 'string')
          await this.unsubscribe(ws, att, arg);
      } catch {
        // malformed packet: ignore, as socket.io does
      }
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    const att = this.att(ws);
    try {
      ws.close(code, reason);
    } catch {
      // already closed
    }
    if (att.userId) await this.pruneStores(att.userId, att.subs, ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws, 1011, 'error');
  }

  private att(ws: WebSocket): Attachment {
    return (ws as unknown as { deserializeAttachment(): Attachment }).deserializeAttachment();
  }

  private setAtt(ws: WebSocket, a: Attachment): void {
    (ws as unknown as { serializeAttachment(v: unknown): void }).serializeAttachment(a);
  }

  private api(path: string, att: Attachment): Promise<Response> {
    const base = (this.env.API_URL ?? '').replace(/\/$/, '');
    const headers: Record<string, string> = { accept: 'application/json' };
    if (att.token) headers.authorization = `Bearer ${att.token}`;
    else if (att.cookie) headers.cookie = att.cookie;
    return fetchWithTimeout(`${base}/api/v1/realtime${path}`, { headers });
  }

  private async onConnect(ws: WebSocket, att: Attachment, raw: string): Promise<void> {
    let token: string | undefined;
    try {
      token = raw ? (JSON.parse(raw) as { token?: string }).token : undefined;
    } catch {
      // no auth payload
    }
    const probe: Attachment = { ...att, token };
    if (!token && !att.cookie) {
      ws.send('44' + JSON.stringify({ message: 'Authentication required' }));
      return;
    }
    type Who = { userId: string; email: string; role: string };
    let who: Who | null = null;
    try {
      const res = await this.api('/session', probe);
      if (res.ok) who = ((await res.json()) as { data: Who }).data;
    } catch {
      // fall through: treated as invalid
    }
    // The Worker routed this socket to `user:<uid>` from the (unverified) handshake query;
    // a token that belongs to someone else is a spoof attempt, never a delivery target.
    if (!who || who.userId !== att.expectUser) {
      ws.send('44' + JSON.stringify({ message: 'Invalid token' }));
      return;
    }
    this.setAtt(ws, { ...probe, userId: who.userId, email: who.email, role: who.role });
    ws.send('40' + JSON.stringify({ sid: att.sid }));
  }

  private async subscribe(ws: WebSocket, att: Attachment, storeId: string): Promise<void> {
    const emitError = (message: string): void =>
      ws.send('42' + JSON.stringify(['error', { message }]));
    if (att.role !== 'store_admin' && att.role !== 'super_admin') {
      return emitError('Insufficient permissions to subscribe to store events');
    }
    let res: Response;
    try {
      res = await this.api(`/stores/${encodeURIComponent(storeId)}/access`, att);
    } catch {
      return emitError('Failed to verify store access');
    }
    if (!res.ok) return emitError('You do not have access to this store');
    if (!att.subs.includes(storeId)) {
      const next = {
        ...att,
        subs: [...att.subs, storeId],
        checked: { ...att.checked, [storeId]: Date.now() },
      };
      this.setAtt(ws, next);
      await this.env.STORE_REALTIME.get(
        this.env.STORE_REALTIME.idFromName(`store:${storeId}`)
      ).addSubscriber(att.userId as string);
    }
  }

  private async unsubscribe(ws: WebSocket, att: Attachment, storeId: string): Promise<void> {
    const next = { ...att, subs: att.subs.filter(s => s !== storeId) };
    this.setAtt(ws, next);
    await this.pruneStores(att.userId as string, [storeId], ws);
  }

  /** Drop this user from rooms none of its OTHER sockets still subscribe to. */
  private async pruneStores(userId: string, stores: string[], except: WebSocket): Promise<void> {
    const still = new Set<string>();
    for (const other of this.ctx.getWebSockets()) {
      if (other === except) continue;
      for (const s of this.att(other).subs) still.add(s);
    }
    for (const storeId of stores) {
      if (still.has(storeId)) continue;
      await this.env.STORE_REALTIME.get(
        this.env.STORE_REALTIME.idFromName(`store:${storeId}`)
      ).removeSubscriber(userId);
    }
  }

  /** RPC: send an event to this user's sockets (all, or those subscribed to `storeId`). */
  async deliver(args: DeliverArgs): Promise<number> {
    const frame = '42' + JSON.stringify([args.event, args.payload]);
    let n = 0;
    for (const ws of this.ctx.getWebSockets()) {
      const att = this.att(ws);
      if (!att.userId) continue;
      if (args.storeId) {
        if (!att.subs.includes(args.storeId)) continue;
        // TEN-7: a store event only goes to a socket whose membership still holds.
        if (!(await this.stillMember(ws, att, args.storeId))) continue;
      }
      try {
        ws.send(frame);
        n++;
      } catch {
        // closed socket: the close handler prunes it
      }
    }
    return n;
  }

  /**
   * Re-check (at most every REVERIFY_MS) that this socket's user may still see `storeId`. A definitive "no"
   * (4xx: removed, token revoked) drops the room for the socket; a transport/5xx failure withholds this one event
   * but keeps the subscription (fail closed on delivery, no spurious unsubscribe on an outage).
   */
  private async stillMember(ws: WebSocket, att: Attachment, storeId: string): Promise<boolean> {
    const last = att.checked?.[storeId] ?? 0;
    if (Date.now() - last < REVERIFY_MS) return true;
    let res: Response;
    try {
      res = await this.api(`/stores/${encodeURIComponent(storeId)}/access`, att);
    } catch {
      return false;
    }
    if (res.ok) {
      this.setAtt(ws, { ...att, checked: { ...att.checked, [storeId]: Date.now() } });
      return true;
    }
    if (res.status >= 400 && res.status < 500) {
      this.setAtt(ws, { ...att, subs: att.subs.filter(s => s !== storeId) });
      try {
        ws.send(
          '42' + JSON.stringify(['error', { message: 'You do not have access to this store' }])
        );
      } catch {
        // closed
      }
      await this.pruneStores(att.userId as string, [storeId], ws);
    }
    return false;
  }

  async alarm(): Promise<void> {
    const sockets = this.ctx.getWebSockets();
    for (const ws of sockets) {
      try {
        ws.send('2'); // Engine.IO PING; the client answers '3'
      } catch {
        // closed
      }
    }
    if (sockets.length > 0) await this.ctx.storage.setAlarm(Date.now() + PING_INTERVAL_MS);
  }

  private async ensurePing(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + PING_INTERVAL_MS);
    }
  }

  // ------------------------------------------------------------ store: the room

  private ensureRoomTable(): void {
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS subs (user_id TEXT PRIMARY KEY)`);
  }

  async addSubscriber(userId: string): Promise<void> {
    this.ensureRoomTable();
    this.ctx.storage.sql.exec(`INSERT OR IGNORE INTO subs (user_id) VALUES (?)`, userId);
  }

  async removeSubscriber(userId: string): Promise<void> {
    this.ensureRoomTable();
    this.ctx.storage.sql.exec(`DELETE FROM subs WHERE user_id = ?`, userId);
  }

  /** RPC: fan an event out to every user subscribed to this store; returns sockets reached. */
  async emitStore(storeId: string, event: string, payload: unknown): Promise<number> {
    this.ensureRoomTable();
    const users = this.ctx.storage.sql.exec(`SELECT user_id FROM subs`).toArray();
    const counts = await Promise.all(
      users.map(u =>
        this.env.STORE_REALTIME.get(
          this.env.STORE_REALTIME.idFromName(`user:${u.user_id as string}`)
        )
          .deliver({ event, payload, storeId })
          .catch(() => 0)
      )
    );
    return counts.reduce((a, b) => a + b, 0);
  }
}
