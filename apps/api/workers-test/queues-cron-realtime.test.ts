import { describe, expect, it } from 'vitest';
import { api, authState, testEnv } from './helpers';

const queued = (id: string, subject: string) => ({
  id,
  storeId: null,
  // Platform sender with no provider configured in the test environment: every send attempt throws.
  // The address must be deliverable-looking: a reserved `.invalid` TLD is dropped before send (Ruling WA-LEGACY-1) and the
  // message would be acked as handled, never retried or parked.
  options: { to: 'someone@exit-test.example.com', subject, html: '<p>h</p>' },
  attempts: 0,
  maxAttempts: 3,
  createdAt: new Date().toISOString(),
});

/** The dead-letter list the super-admin replay page reads (`email:failed`, AuthState). */
const failedIds = async (): Promise<string[]> => {
  const rows = (
    await authState('email:failed', [['lrange', 'email:failed', 0, -1]])
  )[0] as string[];
  return rows.map(r => (JSON.parse(r) as { id: string }).id);
};

async function waitFor<T>(fn: () => Promise<T | undefined | false>, ms = 25_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise(r => setTimeout(r, 250));
  }
}

describe('queue consumers (Cloudflare Queues)', () => {
  it('a message that cannot be delivered is retried, dead-lettered, and parked on the replay list', async () => {
    const id = `email_e2e_${crypto.randomUUID()}`;
    await testEnv.EMAIL_QUEUE.send(queued(id, 'will fail'), { contentType: 'json' });
    // main queue -> attempt fails -> retry after 1 s -> attempt fails -> ebda-email-dlq -> consumer parks it
    await waitFor(async () => (await failedIds()).includes(id));
    expect(await failedIds()).toContain(id);
  });

  it('a message sent straight to the dead-letter queue is parked too (and is not retried)', async () => {
    const id = `email_dlq_${crypto.randomUUID()}`;
    await testEnv.EMAIL_DLQ.send(queued(id, 'dead'), { contentType: 'json' });
    await waitFor(async () => (await failedIds()).includes(id));
    expect((await failedIds()).filter(x => x === id)).toHaveLength(1);
  });

  it('an unreadable message is dropped without being parked or retried forever', async () => {
    await testEnv.EMAIL_QUEUE.send(
      { not: 'an email', marker: 'poison-1' },
      { contentType: 'json' }
    );
    await new Promise(r => setTimeout(r, 3_000));
    const raw = (
      await authState('email:failed', [['lrange', 'email:failed', 0, -1]])
    )[0] as string[];
    expect(raw.some(r => r.includes('poison-1'))).toBe(false);
  });
});

describe('realtime (StoreRealtime durable object, hibernating WebSocket)', () => {
  const upgrade = (path: string, origin: string | null = 'http://localhost:3000') =>
    api.fetch(`https://api.ebda.app${path}`, {
      headers: { upgrade: 'websocket', ...(origin ? { origin } : {}) },
    });
  const uid = crypto.randomUUID();

  it('a plain GET to the socket path says WebSocket is required', async () => {
    const res = await api.fetch('https://api.ebda.app/socket.io/?EIO=4&transport=polling');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'WEBSOCKET_REQUIRED'
    );
  });

  it('a foreign Origin is refused (cross-site WebSocket hijacking: the cookie rides the upgrade)', async () => {
    expect(
      (await upgrade(`/socket.io/?EIO=4&transport=websocket&uid=${uid}`, 'https://evil.example'))
        .status
    ).toBe(403);
    expect((await upgrade(`/socket.io/?EIO=4&transport=websocket&uid=${uid}`, null)).status).toBe(
      403
    );
  });

  it('a missing or malformed uid is a 400', async () => {
    expect((await upgrade('/socket.io/?EIO=4&transport=websocket')).status).toBe(400);
    expect((await upgrade('/socket.io/?EIO=4&transport=websocket&uid=not-a-uuid')).status).toBe(
      400
    );
  });

  it('a platform origin upgrades, gets the Engine.IO open packet, and an unauthenticated CONNECT is refused', async () => {
    const res = await upgrade(`/socket.io/?EIO=4&transport=websocket&uid=${uid}`);
    expect(res.status).toBe(101);
    const ws = res.webSocket!;
    ws.accept();
    const messages: string[] = [];
    ws.addEventListener('message', e => messages.push(String(e.data)));
    // wait for the frame to ARRIVE (poll with a deadline), not a fixed 100 ms that a loaded runner can overrun
    await waitFor(async () => messages.length > 0);
    expect(messages[0].startsWith('0{')).toBe(true);
    expect(JSON.parse(messages[0].slice(1))).toMatchObject({ upgrades: [], pingInterval: 25000 });
    // Socket.IO CONNECT with no token and no cookie.
    ws.send('40');
    await waitFor(async () => messages.some(m => m.startsWith('44')));
    expect(messages.some(m => m.startsWith('44') && m.includes('Authentication required'))).toBe(
      true
    );
    // A token the API cannot vouch for (the DO asks API_URL, which is unreachable here) is refused too.
    ws.send('40' + JSON.stringify({ token: 'garbage' }));
    await waitFor(async () => messages.some(m => m.includes('Invalid token')));
    expect(messages.some(m => m.startsWith('44') && m.includes('Invalid token'))).toBe(true);
    ws.close(1000, 'done');
  });
});
