// Fire a OneSignal test push to admin devices without creating a real
// order. Useful when verifying that a freshly-subscribed device is
// actually reachable end-to-end (browser permission → OneSignal player →
// our DB row → REST broadcast → device buzz).
//
// Run from apps/api/ so @force/database resolves and the
// ONESIGNAL_ADMIN_* / ONESIGNAL_* env vars are loaded:
//
//   node ../../scripts/admin-test-push.mjs                  # all super_admins
//   node ../../scripts/admin-test-push.mjs --email=foo@x.com # just that user
//   node ../../scripts/admin-test-push.mjs --user-id=<uuid>  # by user id
//
// Sends through Railway env so it uses the same admin app id +
// REST key as production:
//
//   railway run -- node ../../scripts/admin-test-push.mjs
//
import 'dotenv/config';
import { prisma } from '@force/database';

const args = Object.fromEntries(
  process.argv.slice(2).flatMap(a => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [[m[1], m[2]]] : [];
  })
);

const APP_ID = process.env.ONESIGNAL_ADMIN_APP_ID || process.env.ONESIGNAL_APP_ID;
const REST_KEY = process.env.ONESIGNAL_ADMIN_REST_API_KEY || process.env.ONESIGNAL_REST_API_KEY;

if (!APP_ID || !REST_KEY) {
  console.error(
    'Missing ONESIGNAL_ADMIN_APP_ID / ONESIGNAL_ADMIN_REST_API_KEY (or the storefront fallbacks).'
  );
  process.exit(1);
}

// Build the user filter. When neither flag is set we broadcast to all
// super_admins, mirroring the prod fan-out for new orders.
const userWhere = args.email
  ? { email: args.email.toLowerCase(), storeId: null }
  : args['user-id']
    ? { id: args['user-id'] }
    : { role: 'super_admin', storeId: null };

const subs = await prisma.oneSignalSubscription.findMany({
  where: { user: userWhere },
  select: {
    playerId: true,
    deviceLabel: true,
    createdAt: true,
    user: { select: { id: true, email: true, role: true } },
  },
  orderBy: { createdAt: 'desc' },
});

if (subs.length === 0) {
  console.log('No matching OneSignal subscriptions found.');
  await prisma.$disconnect();
  process.exit(0);
}

console.log(`Sending test push to ${subs.length} device(s):`);
for (const s of subs) {
  console.log(
    `  - ${s.user.email}  ${s.deviceLabel || 'Unknown'}  player=${s.playerId.slice(0, 8)}…  (${s.createdAt.toISOString().slice(0, 10)})`
  );
}

const playerIds = subs.map(s => s.playerId);
const ts = new Date().toLocaleTimeString();

const body = {
  app_id: APP_ID,
  include_player_ids: playerIds,
  headings: { en: 'Test push', ar: 'إشعار تجريبي' },
  contents: {
    en: `Test from admin-test-push at ${ts}`,
    ar: `إشعار تجريبي من السكربت — ${ts}`,
  },
  data: { type: 'test', firedAt: new Date().toISOString() },
};

const res = await fetch('https://onesignal.com/api/v1/notifications', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Key ${REST_KEY}`,
  },
  body: JSON.stringify(body),
});

const json = await res.json().catch(() => ({}));
console.log(`\nOneSignal response (HTTP ${res.status}):`);
console.log(JSON.stringify(json, null, 2));

if (json.recipients === 0) {
  console.log(
    '\n⚠ recipients=0. The player_ids exist in our DB but OneSignal considers them unsubscribed/expired.'
  );
  console.log(
    '   Common causes: browser permission revoked, iOS PWA not installed to home screen, app uninstalled.'
  );
}
if (json.errors) {
  console.log('\n⚠ Errors from OneSignal:');
  console.log(JSON.stringify(json.errors, null, 2));
}

await prisma.$disconnect();
