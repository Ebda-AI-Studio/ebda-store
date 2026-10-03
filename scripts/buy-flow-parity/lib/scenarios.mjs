/**
 * Buy scenarios. Each one owns its products/coupons (see fixture.mjs) and runs
 * the SAME request sequence the storefront runs (apps/web CheckoutClient.tsx →
 * api.ts), the success page runs (SuccessClient.tsx verify-on-return), the
 * gateway runs (signed webhook) and the admin app runs (status / refund).
 *
 * A scenario that cannot be driven must call ctx.skip(reason) — it is then
 * reported as SKIPPED, never as PASS.
 */
import crypto from 'node:crypto';
import { MF_WEBHOOK_SECRET, OWNER_EMAIL, OWNER_PASSWORD } from './fixture.mjs';

const CUSTOMER_PASSWORD = 'BfpCustomer!Parity2026';

export const ADDRESS_NASR_CITY = {
  firstName: 'Parity',
  lastName: 'Buyer',
  address1: '12 Abbas El Akkad St, Building 3',
  address2: '',
  area: 'Nasr City',
  areaAr: 'مدينة نصر',
  governorate: 'Cairo',
  governorateAr: 'القاهرة',
  street: 'Abbas El Akkad St',
  building: '3',
  floor: '2',
  apartment: '5',
  city: '',
  country: 'Egypt',
  phone: '+201012345678',
  email: 'buyer@bfp-parity.test',
};
export const ADDRESS_GIZA = {
  ...ADDRESS_NASR_CITY,
  area: 'Dokki',
  areaAr: 'الدقي',
  governorate: 'Giza',
  governorateAr: 'الجيزة',
};

/** Storefront add-to-cart (apps/web api.addToCart). */
async function add(shopper, step, productId, quantity = 1, variantId) {
  return shopper.call(step, 'POST', '/public/cart/items', {
    productId,
    quantity,
    ...(variantId ? { variantId } : {}),
  });
}

/**
 * The checkout page's request sequence, in order: cart → payment config →
 * shipping quote → (coupon quote) → create order → create payment.
 */
async function checkout(
  ctx,
  shopper,
  { provider, address = ADDRESS_NASR_CITY, couponCode, orderExtra = {} }
) {
  const cartRes = await shopper.call('checkout.cart', 'GET', '/public/cart');
  const cart = cartRes.body?.data?.cart;
  await shopper.call('checkout.payments-config', 'GET', '/payments/config');
  if (cart) {
    await shopper.call(
      'checkout.shipping-quote',
      'POST',
      `/stores/public/${shopper.storeId}/shipping/calculate`,
      {
        area: address.area,
        orderTotal: cart.subtotal,
        governorate: address.governorate,
      }
    );
  }
  if (couponCode) {
    const basis = (cart?.items ?? []).reduce(
      (sum, i) => sum + (i.variant?.price ?? i.product?.price ?? 0) * i.quantity,
      0
    );
    await shopper.call(
      'checkout.coupon-quote',
      'POST',
      `/stores/public/${shopper.storeId}/coupons/validate`,
      {
        code: couponCode,
        orderTotal: basis,
      }
    );
  }
  const orderRes = await shopper.call('checkout.create-order', 'POST', '/public/orders', {
    shippingAddress: address,
    paymentMethod: provider,
    notes: '',
    couponCode,
    ...orderExtra,
  });
  const order = orderRes.body?.data?.order;
  if (!order) return { orderRes, order: null, paymentRes: null };
  ctx.orderIds.push(order.id);
  const paymentRes = await shopper.call('checkout.create-payment', 'POST', '/payments/create', {
    orderId: order.id,
    provider,
    successUrl: `/checkout/success?orderId=${order.id}`,
    errorUrl: `/checkout/error?orderId=${order.id}`,
  });
  return { orderRes, order, paymentRes };
}

/** Customer returns from the gateway: success page verify-on-return + order read. */
async function returnFromGateway(ctx, shopper, orderId, { paid }) {
  const invoiceId = ctx.stub.lastInvoiceId();
  ctx.stub.setInvoiceStatus(invoiceId, paid ? 'Paid' : 'Failed');
  await shopper.call('return.verify-payment', 'POST', `/public/orders/${orderId}/verify-payment`, {
    paymentId: `PAY-${invoiceId}`,
  });
  await ctx.settle();
  await shopper.call('return.get-order', 'GET', `/public/orders/${orderId}`);
}

/** Gateway → API webhook, signed exactly as PaymentService verifies it. */
async function webhook(ctx, step, { invoiceId, status, value, secret = MF_WEBHOOK_SECRET }) {
  const raw = JSON.stringify({
    Event: 'TransactionsStatusChanged',
    EventType: 1,
    Data: {
      InvoiceId: invoiceId,
      InvoiceStatus: status,
      InvoiceValue: value,
      Currency: 'EGP',
      PaymentMethod: 'VISA/MASTER',
    },
  });
  const sig = crypto.createHmac('sha256', secret).update(raw, 'utf8').digest('hex');
  const r = await ctx.gateway.call(step, 'POST', '/webhooks/payment/myfatoorah', raw, {
    'x-myfatoorah-signature': sig,
  });
  await ctx.settle();
  return r;
}

async function signedInShopper(ctx, label, storeKey = 'main') {
  const shopper = ctx.shopper(label, storeKey);
  const email = `${label}@bfp-parity.test`;
  await shopper.register('auth.register', {
    email,
    password: CUSTOMER_PASSWORD,
    firstName: 'Parity',
    lastName: 'Customer',
  });
  await shopper.login('auth.login', email, CUSTOMER_PASSWORD);
  if (!shopper.csrfToken) ctx.note('login returned no csrfToken');
  return shopper;
}

async function adminLogin(ctx) {
  const admin = ctx.admin();
  await admin.login('admin.login', OWNER_EMAIL, OWNER_PASSWORD);
  return admin;
}

export const SCENARIOS = [
  {
    id: 'guest-mf-single-verify-paid',
    title:
      'Guest, 1 simple item, per-area shipping, MyFatoorah invoice → return → verify-on-return Paid',
    fixture: { products: { tee: { price: 7500, inventory: 10 } } },
    async run(ctx) {
      const s = ctx.shopper('guest-1');
      await add(s, 'cart.add', ctx.p('tee'));
      const { order } = await checkout(ctx, s, { provider: 'myfatoorah' });
      if (order) await returnFromGateway(ctx, s, order.id, { paid: true });
    },
  },
  {
    id: 'guest-mf-multiqty-webhook-paid',
    title: 'Guest, multi-qty, MyFatoorah → signed webhook Paid (+ duplicate replay)',
    fixture: { products: { mug: { price: 3250, inventory: 10 } } },
    async run(ctx) {
      const s = ctx.shopper('guest-2');
      await add(s, 'cart.add', ctx.p('mug'), 3);
      const { order } = await checkout(ctx, s, { provider: 'myfatoorah' });
      if (!order) return;
      const invoiceId = ctx.stub.lastInvoiceId();
      ctx.stub.setInvoiceStatus(invoiceId, 'Paid');
      const value = ctx.stub.state.invoices.get(String(invoiceId))?.value;
      await webhook(ctx, 'gateway.webhook-paid', { invoiceId, status: 'Paid', value });
      await webhook(ctx, 'gateway.webhook-paid-duplicate', { invoiceId, status: 'Paid', value });
      await s.call('return.get-order', 'GET', `/public/orders/${order.id}`);
    },
  },
  {
    id: 'webhook-forged-signature',
    title:
      'Forged (wrongly signed) Paid webhook must not mark the order paid; the real verify-on-return still does',
    fixture: { products: { ring: { price: 25000, inventory: 3 } } },
    async run(ctx) {
      const s = ctx.shopper('guest-forged');
      await add(s, 'cart.add', ctx.p('ring'));
      const { order } = await checkout(ctx, s, { provider: 'myfatoorah' });
      if (!order) return;
      const invoiceId = ctx.stub.lastInvoiceId();
      const value = ctx.stub.state.invoices.get(String(invoiceId))?.value;
      await webhook(ctx, 'attacker.webhook-forged-paid', {
        invoiceId,
        status: 'Paid',
        value,
        secret: 'not-the-secret',
      });
      await s.call('after-forgery.get-order', 'GET', `/public/orders/${order.id}`);
      await returnFromGateway(ctx, s, order.id, { paid: true });
    },
  },
  {
    id: 'customer-mf-variant-pct-coupon',
    title:
      'Signed-in customer, variant product + simple item, percentage coupon, MyFatoorah → verify Paid',
    fixture: {
      products: {
        shoe: {
          price: 6000,
          inventory: 0,
          variants: { S: { price: 6000, inventory: 5 }, L: { price: 8000, inventory: 5 } },
        },
        sock: { price: 1250, inventory: 20 },
      },
      coupons: { PCT10: { type: 'percentage', value: 10 } },
    },
    async run(ctx) {
      const s = await signedInShopper(ctx, 'customer-3');
      await add(s, 'cart.add-variant', ctx.p('shoe'), 2, ctx.v('shoe:L'));
      await add(s, 'cart.add-simple', ctx.p('sock'), 1);
      const { order } = await checkout(ctx, s, {
        provider: 'myfatoorah',
        couponCode: ctx.c('PCT10'),
      });
      if (order) await returnFromGateway(ctx, s, order.id, { paid: true });
    },
  },
  {
    id: 'guest-cod-fee-fixed-coupon',
    title:
      'Guest, COD with COD fee, fixed coupon, Giza rate; payments/create replayed (fee must not stack)',
    fixture: {
      products: { cap: { price: 4000, inventory: 10 } },
      coupons: { FIX2: { type: 'fixed', value: 2000 } },
    },
    async run(ctx) {
      const s = ctx.shopper('guest-4');
      await add(s, 'cart.add', ctx.p('cap'), 2);
      const { order } = await checkout(ctx, s, {
        provider: 'cod',
        address: ADDRESS_GIZA,
        couponCode: ctx.c('FIX2'),
      });
      if (!order) return;
      await s.call('checkout.create-payment-replay', 'POST', '/payments/create', {
        orderId: order.id,
        provider: 'cod',
        successUrl: `/checkout/success?orderId=${order.id}`,
        errorUrl: `/checkout/error?orderId=${order.id}`,
      });
      await ctx.settle();
      await s.call('return.get-order', 'GET', `/public/orders/${order.id}`);
    },
  },
  {
    id: 'customer-cod-free-shipping-threshold',
    title: 'Signed-in customer, COD, subtotal over the free-shipping threshold',
    fixture: { products: { lamp: { price: 45000, inventory: 3 } } },
    async run(ctx) {
      const s = await signedInShopper(ctx, 'customer-5');
      await add(s, 'cart.add', ctx.p('lamp'));
      const { order } = await checkout(ctx, s, { provider: 'cod' });
      if (order) await s.call('return.get-order', 'GET', `/public/orders/${order.id}`);
    },
  },
  {
    id: 'vat-store-mf-pct-coupon',
    title: 'Store with VAT 14% on, percentage coupon, MyFatoorah → verify Paid',
    store: 'vat',
    fixture: {
      products: { box: { price: 12345, inventory: 10 } },
      coupons: { PCT15: { type: 'percentage', value: 15 } },
    },
    async run(ctx) {
      const s = ctx.shopper('guest-6', 'vat');
      await add(s, 'cart.add', ctx.p('box'), 2);
      const { order } = await checkout(ctx, s, {
        provider: 'myfatoorah',
        couponCode: ctx.c('PCT15'),
      });
      if (order) await returnFromGateway(ctx, s, order.id, { paid: true });
    },
  },
  {
    id: 'mf-create-fails-rollback',
    title: 'MyFatoorah invoice creation fails → order rolled back (stock + coupon returned)',
    fixture: {
      products: { pen: { price: 900, inventory: 5 } },
      coupons: { PCT20: { type: 'percentage', value: 20, usageLimit: 5 } },
    },
    async run(ctx) {
      const s = ctx.shopper('guest-7');
      await add(s, 'cart.add', ctx.p('pen'), 4);
      ctx.stub.state.failSendPayment = true;
      const { order } = await checkout(ctx, s, {
        provider: 'myfatoorah',
        couponCode: ctx.c('PCT20'),
      });
      ctx.stub.state.failSendPayment = false;
      await ctx.settle();
      if (order) await s.call('after.get-cart', 'GET', '/public/cart');
    },
  },
  {
    id: 'mf-payment-failed',
    title:
      'MyFatoorah invoice → customer returns with a FAILED payment (verify-on-return) → then signed webhook Failed',
    fixture: { products: { bag: { price: 15000, inventory: 4 } } },
    async run(ctx) {
      const s = ctx.shopper('guest-8');
      await add(s, 'cart.add', ctx.p('bag'));
      const { order } = await checkout(ctx, s, { provider: 'myfatoorah' });
      if (!order) return;
      await returnFromGateway(ctx, s, order.id, { paid: false });
      const invoiceId = ctx.stub.lastInvoiceId();
      const value = ctx.stub.state.invoices.get(String(invoiceId))?.value;
      await webhook(ctx, 'gateway.webhook-failed', { invoiceId, status: 'Failed', value });
      await s.call('after.get-order', 'GET', `/public/orders/${order.id}`);
    },
  },
  {
    id: 'out-of-stock',
    title: 'Out of stock: cart over-add rejected; last unit sold to someone else → order rejected',
    fixture: { products: { rare: { price: 20000, inventory: 1 } } },
    async run(ctx) {
      const a = ctx.shopper('guest-9a');
      await add(a, 'a.cart.add-over-stock', ctx.p('rare'), 2);
      await add(a, 'a.cart.add-one', ctx.p('rare'), 1);
      const b = ctx.shopper('guest-9b');
      await add(b, 'b.cart.add-one', ctx.p('rare'), 1);
      await checkout(ctx, b, { provider: 'cod' });
      await checkout(ctx, a, { provider: 'cod' });
    },
  },
  {
    id: 'price-tampering',
    title: 'Client-asserted prices/totals/discount are ignored or rejected (server recomputes)',
    fixture: {
      products: { watch: { price: 55000, inventory: 5 } },
      coupons: { FIX5: { type: 'fixed', value: 5000, minOrderAmount: 50000 } },
    },
    async run(ctx) {
      const s = ctx.shopper('guest-10');
      await s.call('cart.add-with-price', 'POST', '/public/cart/items', {
        productId: ctx.p('watch'),
        quantity: 1,
        price: 1,
        unitPrice: 1,
      });
      // Coupon quote with a forged basis (client says the cart is worth more).
      await s.call('coupon.forged-basis', 'POST', `/stores/public/${s.storeId}/coupons/validate`, {
        code: ctx.c('FIX5'),
        orderTotal: 999999,
      });
      const { order } = await checkout(ctx, s, {
        provider: 'myfatoorah',
        couponCode: ctx.c('FIX5'),
        orderExtra: {
          subtotal: 1,
          tax: 0,
          shipping: 0,
          discount: 54999,
          total: 1,
          items: [{ productId: ctx.p('watch'), quantity: 1, price: 1 }],
        },
      });
      if (order) await returnFromGateway(ctx, s, order.id, { paid: true });
    },
  },
  {
    id: 'bundle-checkout-mf',
    title: 'Bundle (fixed-price box) checkout, MyFatoorah → verify Paid',
    fixture: {
      products: { soap: { price: 2500, inventory: 10 }, towel: { price: 6500, inventory: 10 } },
      bundles: {
        spa: {
          pricingType: 'fixed_price',
          pricingValue: 7777,
          items: [
            { product: 'soap', quantity: 2 },
            { product: 'towel', quantity: 1 },
          ],
        },
      },
    },
    async run(ctx) {
      const s = ctx.shopper('guest-11');
      await s.call('cart.add-bundle', 'POST', '/public/cart/bundles', {
        bundleId: ctx.b('spa'),
        quantity: 2,
      });
      await add(s, 'cart.add-loose', ctx.p('soap'), 1);
      const { order } = await checkout(ctx, s, { provider: 'myfatoorah' });
      if (order) await returnFromGateway(ctx, s, order.id, { paid: true });
    },
  },
  {
    id: 'area-not-deliverable',
    title: 'Delivery area with no rate is refused at order creation (no undercharge)',
    fixture: { products: { kite: { price: 3000, inventory: 5 } } },
    async run(ctx) {
      const s = ctx.shopper('guest-12');
      await add(s, 'cart.add', ctx.p('kite'));
      await checkout(ctx, s, {
        provider: 'cod',
        address: {
          ...ADDRESS_NASR_CITY,
          area: 'Nowhere',
          areaAr: 'لا مكان',
          governorate: 'Nowhere',
          governorateAr: '',
        },
      });
    },
  },
  {
    id: 'paid-refund-via-provider',
    title: 'Paid MyFatoorah order → admin full refund via provider → refund pending',
    fixture: { products: { desk: { price: 30000, inventory: 3 } } },
    async run(ctx) {
      const s = ctx.shopper('guest-13');
      await add(s, 'cart.add', ctx.p('desk'));
      const { order } = await checkout(ctx, s, { provider: 'myfatoorah' });
      if (!order) return;
      await returnFromGateway(ctx, s, order.id, { paid: true });
      const admin = await adminLogin(ctx);
      await admin.call(
        'admin.refund-via-provider',
        'POST',
        `/stores/${s.storeId}/orders/${order.id}/refund-via-provider`,
        {
          reason: 'parity full refund',
        }
      );
      await ctx.settle();
      await admin.call('admin.get-order', 'GET', `/stores/${s.storeId}/orders/${order.id}`);
    },
  },
  {
    id: 'paid-cancel-then-refund',
    title: 'Paid MyFatoorah order → admin cancels → admin refunds via provider',
    fixture: { products: { chair: { price: 18000, inventory: 3 } } },
    async run(ctx) {
      const s = ctx.shopper('guest-14');
      await add(s, 'cart.add', ctx.p('chair'));
      const { order } = await checkout(ctx, s, { provider: 'myfatoorah' });
      if (!order) return;
      await returnFromGateway(ctx, s, order.id, { paid: true });
      const admin = await adminLogin(ctx);
      await admin.call('admin.cancel', 'PUT', `/stores/${s.storeId}/orders/${order.id}/status`, {
        status: 'cancelled',
      });
      await ctx.settle();
      await admin.call(
        'admin.refund-via-provider',
        'POST',
        `/stores/${s.storeId}/orders/${order.id}/refund-via-provider`,
        {
          reason: 'parity refund after cancel',
        }
      );
      await ctx.settle();
      await admin.call('admin.get-order', 'GET', `/stores/${s.storeId}/orders/${order.id}`);
    },
  },
  {
    id: 'cod-cancel-restock',
    title: 'COD order with coupon → admin cancels → stock and coupon usage returned',
    fixture: {
      products: { vase: { price: 9000, inventory: 4 } },
      coupons: { PCT5: { type: 'percentage', value: 5 } },
    },
    async run(ctx) {
      const s = ctx.shopper('guest-15');
      await add(s, 'cart.add', ctx.p('vase'), 2);
      const { order } = await checkout(ctx, s, { provider: 'cod', couponCode: ctx.c('PCT5') });
      if (!order) return;
      const admin = await adminLogin(ctx);
      await admin.call('admin.confirm', 'PUT', `/stores/${s.storeId}/orders/${order.id}/status`, {
        status: 'confirmed',
      });
      await admin.call('admin.cancel', 'PUT', `/stores/${s.storeId}/orders/${order.id}/status`, {
        status: 'cancelled',
      });
      await ctx.settle();
    },
  },
];
