// Minimal ambient types for the two `cloudflare:*` runtime modules the API uses.
// The API package type-checks against @types/node (Express, Prisma, pg), which
// conflicts with @cloudflare/workers-types' globals, so the Worker-only surface is
// declared here and everything else in src/cf is written against the structural
// types in ./bindings.ts.
declare module 'cloudflare:node' {
  export function handleAsNodeRequest(
    port: number | { port: number },
    request: Request,
    env?: unknown,
    ctx?: unknown
  ): Promise<Response>;
}

declare module 'cloudflare:workers' {
  export class DurableObject<Env = unknown> {
    constructor(ctx: DurableObjectStateLike, env: Env);
    protected ctx: DurableObjectStateLike;
    protected env: Env;
  }
  export class WorkerEntrypoint<Env = unknown> {
    constructor(ctx: unknown, env: Env);
    protected ctx: unknown;
    protected env: Env;
  }
  /** Workflows base class (it lives in `cloudflare:workers`; `NonRetryableError` is in `cloudflare:workflows`). */
  export abstract class WorkflowEntrypoint<Env = unknown, Params = unknown> {
    protected ctx: { waitUntil(p: Promise<unknown>): void };
    protected env: Env;
    constructor(ctx: { waitUntil(p: Promise<unknown>): void }, env: Env);
    abstract run(
      event: { payload: Readonly<Params>; timestamp: Date; instanceId: string },
      step: unknown
    ): Promise<unknown>;
  }
  export const env: Record<string, unknown>;
}

/** The slice of DurableObjectState the API's Durable Objects use. */
interface DurableObjectStateLike {
  storage: {
    sql: {
      exec(
        query: string,
        ...bindings: unknown[]
      ): {
        toArray(): Array<Record<string, unknown>>;
        rowsWritten: number;
        rowsRead: number;
        one(): Record<string, unknown>;
        [Symbol.iterator](): Iterator<Record<string, unknown>>;
      };
    };
    transactionSync<T>(fn: () => T): T;
    /** Async transaction (storage-only awaits): prisma-lite's interactive `$transaction`. */
    transaction<T>(fn: () => Promise<T>): Promise<T>;
    setAlarm(time: number | Date): Promise<void>;
    getAlarm(): Promise<number | null>;
    deleteAlarm(): Promise<void>;
    deleteAll(): Promise<void>;
  };
  acceptWebSocket(ws: WebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): WebSocket[];
  getTags(ws: WebSocket): string[];
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
  waitUntil(p: Promise<unknown>): void;
}

/** workerd's WebSocketPair (index 0 = client end, 1 = server end). */
declare class WebSocketPair {
  0: WebSocket;
  1: WebSocket;
}

declare module 'cloudflare:workflows' {
  export class NonRetryableError extends Error {
    constructor(message: string, name?: string);
  }
}
