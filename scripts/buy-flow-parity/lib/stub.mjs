/**
 * Network stub shared by both sides: a fake Paymob (Accept, Intention API), a fake
 * Inngest event endpoint, and a sink for any other outbound call. Every request is
 * recorded so the snapshot can include EXACTLY what the API sent to the gateway
 * (amount in cents == piastres, currency, items, billing data, callback URLs, the
 * `Token` auth header).
 *
 * Order / transaction ids are deterministic: `setScenario(index)` resets the
 * counters to a per-scenario base, so the same scenario gets the same ids on both
 * sides even when run with --only.
 *
 * The shapes mirror tests/stubs/paymob-stub.ts (the unit-test twin the adapter's
 * contract suite runs against); both are what `paymob.provider.ts` ASSUMES about
 * Paymob, and 6c checks those assumptions against a real sandbox.
 */
import http from 'node:http';

/** Integration id per method the fixture enables (settings.integrationIds). */
export const PAYMOB_INTEGRATIONS = { card: 11, wallet: 22, valu: 33, kiosk: 44, applepay: 55 };

/** The auth token POST /api/auth/tokens hands out (docs: `{profile, token}`). */
const PAYMOB_AUTH_TOKEN = 'bfp-parity-paymob-auth-token';

/**
 * `secretKey` = Paymob Secret key (`Authorization: Token`); `apiKey` = Paymob API key for
 * /api/auth/tokens (when omitted, any non-empty api_key is accepted).
 */
export function createStub({ secretKey, apiKey }) {
  const state = {
    requests: [],
    orders: new Map(), // orderId -> { amount, merchantRef, txnId, status }
    txns: new Map(), // txnId -> { id, orderId, amount_cents, success, pending, is_voided, refunded }
    nextOrder: 0,
    nextTxn: 0,
    failIntention: false,
    // Inngest: function configs captured from the SDK's registration call, and
    // the FIFO of received events the harness executor drains (inngest-executor.mjs).
    functions: [],
    eventQueue: [],
    eventSeq: 0,
  };

  function record(entry) {
    state.requests.push({ seq: state.requests.length, ...entry });
  }

  function json(res, code, body) {
    const s = JSON.stringify(body);
    res.writeHead(code, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(s),
    });
    res.end(s);
  }

  function txnView(order) {
    const t = order.txnId ? state.txns.get(order.txnId) : null;
    const orderRef = {
      id: order.id,
      amount_cents: order.amount,
      merchant_order_id: order.merchantRef,
    };
    if (!t) {
      return {
        id: null,
        success: false,
        pending: true,
        amount_cents: order.amount,
        is_voided: false,
        is_refunded: false,
        refunded_amount_cents: 0,
        currency: 'EGP',
        order: orderRef,
      };
    }
    return {
      ...t,
      currency: 'EGP',
      source_data: { type: 'card', pan: '2346', sub_type: 'MasterCard' },
      order: orderRef,
    };
  }

  function handlePaymob(path, body, headers, res) {
    // Docs: the auth-token request and the order inquiry carry their credential in the BODY.
    if (path === '/api/auth/tokens') {
      if (!body?.api_key || (apiKey && body.api_key !== apiKey)) {
        return json(res, 401, { detail: 'Invalid api_key.' });
      }
      return json(res, 200, { profile: { id: 106 }, token: PAYMOB_AUTH_TOKEN });
    }
    if (path === '/api/ecommerce/orders/transaction_inquiry') {
      // The documented shape is `auth_token` in the body. A BASE ref built before the adapter
      // followed the docs (2026-10-07) sends `Authorization: Token <secret>` instead; accept that
      // too so the harness can still run the base side of a comparison.
      const legacyBase = headers.authorization === `Token ${secretKey}`;
      if (body?.auth_token !== PAYMOB_AUTH_TOKEN && !legacyBase) {
        return json(res, 401, { detail: 'Invalid auth_token.' });
      }
      const order = state.orders.get(String(body?.order_id));
      if (!order) return json(res, 404, { detail: 'order not found' });
      return json(res, 200, txnView(order));
    }
    if (headers.authorization !== `Token ${secretKey}`) {
      return json(res, 401, { detail: 'Authentication credentials were not provided.' });
    }
    switch (path) {
      case '/v1/intention/': {
        if (state.failIntention) {
          return json(res, 400, { detail: 'stubbed gateway rejection' });
        }
        const items = Array.isArray(body?.items) ? body.items : [];
        const total = items.reduce((n, i) => n + i.amount * i.quantity, 0);
        if (!Number.isInteger(body?.amount) || body.amount <= 0 || total !== body.amount) {
          return json(res, 400, { detail: 'amount / items mismatch' });
        }
        const id = state.nextOrder++;
        state.orders.set(String(id), {
          id,
          amount: body.amount,
          merchantRef: body.special_reference ?? '',
          txnId: null,
          status: 'Pending',
        });
        return json(res, 201, {
          id: `pi_test_stub${id}`,
          client_secret: `egy_csk_test_stub${id}`,
          intention_order_id: id,
          intention_detail: { amount: body.amount },
        });
      }
      case '/api/acceptance/void_refund/void':
      case '/api/acceptance/void_refund/refund': {
        const t = state.txns.get(Number(body?.transaction_id));
        if (!t || !t.success) return json(res, 400, { detail: 'transaction not captured' });
        const isVoid = path.endsWith('/void');
        const amount = isVoid ? t.amount_cents : body?.amount_cents;
        if (
          !Number.isInteger(amount) ||
          amount <= 0 ||
          t.is_voided ||
          amount > t.amount_cents - t.refunded
        ) {
          return json(res, 400, { detail: 'not refundable' });
        }
        t.refunded += amount;
        if (isVoid) t.is_voided = true;
        const id = state.nextTxn++;
        const r = {
          id,
          orderId: t.orderId,
          amount_cents: amount,
          success: true,
          pending: false,
          is_voided: isVoid,
          is_refunded: !isVoid,
          parent_transaction: t.id,
          refunded_amount_cents: 0,
        };
        state.txns.set(id, { ...r, refunded: 0 });
        return json(res, 200, r);
      }
      default:
        return json(res, 404, { detail: `stub: unknown Paymob endpoint ${path}` });
    }
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = raw;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        /* keep raw */
      }
      const url = new URL(req.url, 'http://stub');
      const path = url.pathname;

      if (path.startsWith('/paymob/')) {
        const pmPath = path.slice('/paymob'.length);
        record({
          service: 'paymob',
          method: req.method,
          path: pmPath,
          authorization: req.headers.authorization ?? null,
          body,
        });
        return handlePaymob(pmPath, body, req.headers, res);
      }

      if (path.startsWith('/__outbound/')) {
        record({
          service: 'outbound',
          method: req.method,
          path: path.slice('/__outbound'.length),
          body: null,
        });
        return json(res, 503, { error: 'blocked by buy-flow-parity harness' });
      }

      // Inngest (INNGEST_BASE_URL points here). The SDK registers its function
      // configs at POST /fn/register and sends events to POST /e/<key>.
      if (path === '/fn/register' && req.method === 'POST') {
        state.functions = Array.isArray(body?.functions) ? body.functions : [];
        return json(res, 200, { ok: true, modified: true });
      }
      if (path.startsWith('/e/') && req.method === 'POST') {
        const events = Array.isArray(body) ? body : [body];
        const ids = [];
        for (const ev of events) {
          const id = `evt-${++state.eventSeq}`;
          ids.push(id);
          record({
            service: 'inngest',
            method: 'POST',
            path: '/e',
            event: { name: ev?.name, data: ev?.data },
          });
          state.eventQueue.push({ ...ev, id });
        }
        return json(res, 200, { ids, status: 200 });
      }

      // Anything else the Inngest SDK may probe (dev-server discovery etc.).
      return json(res, 200, {});
    });
  });

  return {
    state,
    listen(port) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve(server.address().port));
      });
    },
    close() {
      return new Promise(resolve => server.close(() => resolve()));
    },
    /** Reset per-scenario state. Ids are derived from the scenario index. */
    setScenario(index) {
      state.requests = [];
      state.nextOrder = 7000000 + index * 100;
      state.nextTxn = 8000000 + index * 100;
      state.failIntention = false;
    },
    /** The customer pays (or the payment fails) at Paymob: a transaction on the order. */
    setPaymentStatus(orderId, outcome) {
      const order = state.orders.get(String(orderId));
      if (!order) throw new Error(`stub: no order ${orderId}`);
      const id = state.nextTxn++;
      const paid = outcome === 'Paid';
      state.txns.set(id, {
        id,
        orderId: order.id,
        amount_cents: order.amount,
        success: paid,
        pending: false,
        is_voided: false,
        is_refunded: false,
        refunded_amount_cents: 0,
        refunded: 0,
        parent_transaction: null,
        created_at: '2026-10-04T10:00:00.000000',
      });
      order.txnId = id;
      order.status = outcome;
      return state.txns.get(id);
    },
    /** The id of the Paymob order the last /v1/intention/ call created. */
    lastOrderId() {
      return state.nextOrder - 1;
    },
    takeRequests() {
      const r = state.requests;
      state.requests = [];
      return r;
    },
  };
}
