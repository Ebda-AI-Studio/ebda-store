/**
 * FWB Gmail → Telegram alert forwarder.
 *
 * Reads emails labeled "AlertsForward" in Ahmad's Gmail, POSTs each to
 * the API's generic alert webhook, then archives + marks read so the
 * same email never fires twice.
 *
 * Setup:
 *   1. Paste this into script.google.com → New Project
 *   2. Save as "FWB Alert Forwarder"
 *   3. Add a time-driven trigger: every 5 minutes → processAlerts
 *   4. Grant Gmail + UrlFetch permissions when prompted
 *   5. Create a Gmail filter (Settings → Filters → Create new filter):
 *        From: notifications@sentry.io OR alerts@betterstack.com OR
 *              hello@posthog.com OR alert@uptimerobot.com OR
 *              noreply@vercel.com OR notifications@railway.app
 *        Apply label: AlertsForward (create it)
 *        Optionally: Skip Inbox (keeps your main inbox clean)
 *
 * Cost: free. Apps Script free quota covers ~20k email-forwards/day.
 */

// Generic alert webhook — accepts {title, body, level, source}.
const BRIDGE_URL = 'https://api.force-ai.co/api/v1/alerts/webhooks/generic';
const TOKEN = '19b2054b6bc6e1200c06e0a4dc71cf40';

// Sender-domain → source label so the Telegram message header tells you
// which external service raised the alarm. Falls back to gmail.unknown.
const SOURCE_MAP = {
  'sentry.io': 'sentry',
  'betterstack.com': 'betterstack',
  'logtail.com': 'betterstack',
  'posthog.com': 'posthog',
  'uptimerobot.com': 'uptimerobot',
  'vercel.com': 'vercel',
  'railway.app': 'railway',
  'neon.tech': 'neon',
};

function resolveSource(fromHeader) {
  const lower = (fromHeader || '').toLowerCase();
  for (const [domain, src] of Object.entries(SOURCE_MAP)) {
    if (lower.indexOf(domain) !== -1) return src;
  }
  return 'gmail.unknown';
}

function processAlerts() {
  // Up to 50 threads per run — plenty for hobby-scale traffic, well under
  // the per-execution 6-min limit + per-day UrlFetch quota (20k).
  const threads = GmailApp.search('label:AlertsForward is:unread', 0, 50);
  let forwarded = 0;
  let failed = 0;

  for (const thread of threads) {
    const msgs = thread.getMessages();
    // Forward only the most recent message (alerts that are part of a
    // longer reply chain are already noise; the first/latest carries the
    // event). Marking the whole thread read prevents reprocessing.
    const msg = msgs[msgs.length - 1];

    const from = msg.getFrom();
    const subject = msg.getSubject() || 'untitled alert';
    const body = (msg.getPlainBody() || '').slice(0, 500);
    const source = resolveSource(from);

    const payload = {
      title: subject.slice(0, 200),
      body: body,
      level: 'p1',
      source: 'email.' + source,
    };

    try {
      const res = UrlFetchApp.fetch(BRIDGE_URL + '?token=' + TOKEN, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(payload),
        muteHttpExceptions: true,
      });
      const code = res.getResponseCode();
      if (code >= 200 && code < 300) {
        forwarded++;
        thread.markRead();
        thread.moveToArchive();
      } else {
        failed++;
        Logger.log('bridge HTTP ' + code + ' for "' + subject + '" — leaving unread for retry');
      }
    } catch (e) {
      failed++;
      Logger.log('UrlFetch threw for "' + subject + '": ' + e.toString());
    }
  }

  Logger.log('processAlerts: forwarded=' + forwarded + ' failed=' + failed);
}

/** Manual test — run this once from the IDE to verify the pipeline. */
function smokeTest() {
  const res = UrlFetchApp.fetch(BRIDGE_URL + '?token=' + TOKEN, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({
      title: 'Gmail Apps Script smoke test',
      body: 'verifying the gmail→bridge→telegram pipeline from script.google.com',
      level: 'p1',
      source: 'email.smoke',
    }),
    muteHttpExceptions: true,
  });
  Logger.log('smokeTest: HTTP ' + res.getResponseCode() + ' body=' + res.getContentText());
}
