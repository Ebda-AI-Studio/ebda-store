/**
 * Network stub shared by both refs: a fake MyFatoorah v2 API, a fake Inngest
 * event endpoint, and a sink for any other outbound call. Every request is
 * recorded so the snapshot can include EXACTLY what the API sent to the
 * gateway (amounts, currency, customer fields, callback URLs, auth header).
 *
 * Invoice / refund ids are deterministic: `setScenario(index)` resets the
 * counters to a per-scenario base, so the same scenario gets the same ids on
 * both refs even when run with --only.
 */
import http from 'node:http';

const PAYMENT_METHODS = [
  {
    PaymentMethodId: 1,
    PaymentMethodAr: 'كي نت',
    PaymentMethodEn: 'KNET',
    PaymentMethodCode: 'kn',
    IsDirectPayment: false,
    ServiceCharge: 0,
    TotalAmount: 0,
    CurrencyIso: 'KWD',
    ImageUrl: 'https://stub.invalid/kn.png',
  },
  {
    PaymentMethodId: 2,
    PaymentMethodAr: 'فيزا / ماستر',
    PaymentMethodEn: 'VISA/MASTER',
    PaymentMethodCode: 'vm',
    IsDirectPayment: false,
    ServiceCharge: 0,
    TotalAmount: 0,
    CurrencyIso: 'KWD',
    ImageUrl: 'https://stub.invalid/vm.png',
  },
];

export function createStub() {
  const state = {
    requests: [],
    invoices: new Map(), // invoiceId -> { status, value, customerReference }
    nextInvoice: 0,
    nextRefund: 0,
    failSendPayment: false,
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

  function handleMf(path, body, res) {
    switch (path) {
      case '/v2/InitiatePayment':
        return json(res, 200, {
          IsSuccess: true,
          Message: '',
          Data: { PaymentMethods: PAYMENT_METHODS },
        });
      case '/v2/SendPayment': {
        if (state.failSendPayment) {
          return json(res, 400, {
            IsSuccess: false,
            Message: 'Invalid data',
            ValidationErrors: [{ Name: 'CustomerMobile', Error: 'stubbed gateway rejection' }],
            Data: null,
          });
        }
        const id = state.nextInvoice++;
        state.invoices.set(String(id), {
          status: 'Pending',
          value: body?.InvoiceValue,
          customerReference: body?.CustomerReference,
        });
        return json(res, 200, {
          IsSuccess: true,
          Message: 'Invoice Created Successfully!',
          ValidationErrors: null,
          Data: {
            InvoiceId: id,
            InvoiceURL: `https://stub-gateway.invalid/pay/${id}`,
            CustomerReference: body?.CustomerReference ?? '',
            UserDefinedField: body?.UserDefinedField ?? '',
          },
        });
      }
      case '/v2/GetPaymentStatus': {
        const inv = state.invoices.get(String(body?.Key));
        if (!inv)
          return json(res, 400, { IsSuccess: false, Message: 'Invoice not found', Data: null });
        const paid = inv.status === 'Paid';
        return json(res, 200, {
          IsSuccess: true,
          Message: '',
          Data: {
            InvoiceId: Number(body.Key),
            InvoiceStatus: inv.status,
            InvoiceReference: `INVREF-${body.Key}`,
            CustomerReference: inv.customerReference ?? '',
            InvoiceValue: inv.value,
            CustomerName: '',
            CustomerMobile: '',
            CustomerEmail: '',
            TransactionStatus: paid ? 'Succss' : inv.status,
            PaymentMethod: paid ? 'KNET' : '',
            PaymentId: paid ? `PAY-${body.Key}` : '',
            PaidCurrency: 'KWD',
            PaidCurrencyValue: paid ? inv.value : 0,
            InvoiceTransactions: [],
          },
        });
      }
      case '/v2/MakeRefund': {
        const id = state.nextRefund++;
        return json(res, 200, {
          IsSuccess: true,
          Message: 'Refund request submitted',
          Data: {
            Key: String(body?.Key ?? ''),
            RefundId: id,
            Amount: body?.Amount,
            RefundReference: `RFREF-${id}`,
          },
        });
      }
      case '/v2/GetRefundStatus':
        return json(res, 200, {
          IsSuccess: true,
          Data: {
            RefundStatusResult: [
              {
                RefundId: Number(body?.Key),
                RefundStatus: 'Pending',
                InvoiceId: 0,
                Amount: 0,
                RefundReference: '',
                RefundAmount: 0,
              },
            ],
          },
        });
      default:
        return json(res, 404, {
          IsSuccess: false,
          Message: `stub: unknown MyFatoorah endpoint ${path}`,
        });
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

      if (path.startsWith('/mf/')) {
        const mfPath = path.slice(3);
        record({
          service: 'myfatoorah',
          method: req.method,
          path: mfPath,
          authorization: req.headers.authorization ?? null,
          body,
        });
        return handleMf(mfPath, body, res);
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
      state.nextInvoice = 7000000 + index * 100;
      state.nextRefund = 8000000 + index * 100;
      state.failSendPayment = false;
    },
    setInvoiceStatus(invoiceId, status) {
      const inv = state.invoices.get(String(invoiceId));
      if (!inv) throw new Error(`stub: no invoice ${invoiceId}`);
      inv.status = status;
    },
    lastInvoiceId() {
      return state.nextInvoice - 1;
    },
    takeRequests() {
      const r = state.requests;
      state.requests = [];
      return r;
    },
  };
}
