/** The Cloudflare Queues consumers (apps/api/src/cf/queues.ts): ack / retry / dead-letter semantics. */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { emailQueue, smsQueue, runInStoreScope } = vi.hoisted(() => ({
  emailQueue: { deliver: vi.fn(), parkDeadLetter: vi.fn() },
  smsQueue: { deliver: vi.fn(), parkDeadLetter: vi.fn() },
  runInStoreScope: vi.fn(async (_storeId: string, fn: () => Promise<unknown>) => fn()),
}));

vi.mock('@api/services/email-queue.service', () => ({
  emailQueue,
  isQueuedEmail: (v: any) => !!v && typeof v.id === 'string' && !!v.options?.to,
}));
vi.mock('@api/services/sms-queue.service', () => ({
  smsQueue,
  isQueuedSms: (v: any) => !!v && typeof v.id === 'string' && typeof v.storeId === 'string',
}));
vi.mock('@force/database', () => ({ runInStoreScope }));
vi.mock('@api/lib/logger', () => ({
  default: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { handleQueueBatch, retryDelaySeconds, type QueueMessageLike } from '@api/cf/queues';

const message = (
  body: unknown,
  attempts = 1
): QueueMessageLike & { acked: boolean; retried?: { delaySeconds?: number } } => {
  const m = {
    id: `m-${Math.random()}`,
    body,
    attempts,
    acked: false,
    retried: undefined as { delaySeconds?: number } | undefined,
    ack() {
      m.acked = true;
    },
    retry(opts?: { delaySeconds?: number }) {
      m.retried = opts ?? {};
    },
  };
  return m;
};

const email = {
  id: 'email_1',
  storeId: 'store-1',
  options: { to: 'a@b.c', subject: 's', html: 'h' },
  attempts: 0,
};
const sms = {
  id: 'sms_1',
  storeId: 'store-1',
  idempotencyKey: 'k',
  recipientPhone: '+20',
  messageText: 't',
  config: {},
};

beforeEach(() => {
  vi.clearAllMocks();
  emailQueue.deliver.mockResolvedValue(undefined);
  smsQueue.deliver.mockResolvedValue(undefined);
});

describe('retryDelaySeconds', () => {
  it('doubles from 5 s per attempt and caps at 5 minutes', () => {
    expect([1, 2, 3, 4].map(retryDelaySeconds)).toEqual([5, 10, 20, 40]);
    expect(retryDelaySeconds(30)).toBe(300);
    expect(retryDelaySeconds(0)).toBe(5);
  });
});

describe('main queues', () => {
  it('a delivered email is acked, delivered in its store scope, with the attempt count the platform kept', async () => {
    const m = message(email, 3);
    await handleQueueBatch({ queue: 'ebda-email', messages: [m] });
    expect(m.acked).toBe(true);
    expect(runInStoreScope).toHaveBeenCalledWith('store-1', expect.any(Function));
    expect(emailQueue.deliver).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'email_1', attempts: 2 })
    );
  });

  it('a platform email (no store) is delivered without a store scope', async () => {
    const m = message({ ...email, storeId: null });
    await handleQueueBatch({ queue: 'ebda-email', messages: [m] });
    expect(runInStoreScope).not.toHaveBeenCalled();
    expect(emailQueue.deliver).toHaveBeenCalled();
    expect(m.acked).toBe(true);
  });

  it('a failed delivery is retried with a growing delay and NOT acked', async () => {
    emailQueue.deliver.mockRejectedValue(new Error('provider down'));
    const first = message(email, 1);
    const third = message(email, 3);
    await handleQueueBatch({ queue: 'ebda-email', messages: [first, third] });
    expect(first.acked).toBe(false);
    expect(first.retried).toEqual({ delaySeconds: 5 });
    expect(third.retried).toEqual({ delaySeconds: 20 });
  });

  it('one bad message does not stop the rest of the batch', async () => {
    emailQueue.deliver.mockRejectedValueOnce(new Error('x')).mockResolvedValue(undefined);
    const bad = message(email);
    const good = message({ ...email, id: 'email_2' });
    await handleQueueBatch({ queue: 'ebda-email', messages: [bad, good] });
    expect(bad.retried).toBeDefined();
    expect(good.acked).toBe(true);
  });

  it('an unreadable body is acked (a retry cannot fix it), never delivered, never retried', async () => {
    const m = message({ not: 'an email' });
    await handleQueueBatch({ queue: 'ebda-email', messages: [m] });
    expect(m.acked).toBe(true);
    expect(m.retried).toBeUndefined();
    expect(emailQueue.deliver).not.toHaveBeenCalled();
  });

  it('SMS runs in the store scope of the message and retries on failure', async () => {
    smsQueue.deliver.mockRejectedValueOnce(new Error('gateway'));
    const m = message(sms, 2);
    await handleQueueBatch({ queue: 'ebda-sms', messages: [m] });
    expect(runInStoreScope).toHaveBeenCalledWith('store-1', expect.any(Function));
    expect(m.retried).toEqual({ delaySeconds: 10 });
  });
});

describe('dead-letter queues', () => {
  it('park the email on the replay list, then ack', async () => {
    const m = message(email);
    await handleQueueBatch({ queue: 'ebda-email-dlq', messages: [m] });
    expect(emailQueue.parkDeadLetter).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'email_1' })
    );
    expect(emailQueue.deliver).not.toHaveBeenCalled(); // a dead letter is never re-sent here
    expect(m.acked).toBe(true);
  });

  it('park the SMS (failure log + replay list) inside its store scope', async () => {
    const m = message(sms);
    await handleQueueBatch({ queue: 'ebda-sms-dlq', messages: [m] });
    expect(runInStoreScope).toHaveBeenCalledWith('store-1', expect.any(Function));
    expect(smsQueue.parkDeadLetter).toHaveBeenCalled();
    expect(m.acked).toBe(true);
  });

  it('a failing park is retried (the entry must not be lost)', async () => {
    emailQueue.parkDeadLetter.mockRejectedValue(new Error('do unavailable'));
    const m = message(email);
    await handleQueueBatch({ queue: 'ebda-email-dlq', messages: [m] });
    expect(m.acked).toBe(false);
    expect(m.retried).toBeDefined();
  });
});

it('a message for an unknown queue is acked instead of retried forever', async () => {
  const m = message(email);
  await handleQueueBatch({ queue: 'ebda-something-else', messages: [m] });
  expect(m.acked).toBe(true);
});
